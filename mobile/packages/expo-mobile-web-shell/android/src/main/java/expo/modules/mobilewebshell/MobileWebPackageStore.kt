package expo.modules.mobilewebshell

import android.content.Context
import android.util.Base64
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.FileOutputStream
import java.io.IOException
import java.security.MessageDigest
import java.security.SecureRandom

private const val MANIFEST_JSON_BYTE_LIMIT = 256 * 1024
private const val ASSET_BYTE_LIMIT = 10 * 1024 * 1024
private const val ASSET_BASE64_CHARACTER_LIMIT = ((ASSET_BYTE_LIMIT + 2) / 3) * 4
private const val MAXIMUM_CACHED_HOSTS = 4
private const val MANIFEST_FILE_NAME = "manifest.json"
private const val STAGING_DIRECTORY_NAME = "tmp"
private val SHA256_PATTERN = Regex("^[a-f0-9]{64}$")
private val SAFE_PATH_PATTERN = Regex("^[A-Za-z0-9._/-]+$")
private val ASSET_METADATA_BY_EXTENSION = mapOf(
  "css" to ("text/css; charset=utf-8" to "style"),
  "js" to ("text/javascript; charset=utf-8" to "script"),
  "png" to ("image/png" to "image"),
  "svg" to ("image/svg+xml; charset=utf-8" to "image"),
  "wasm" to ("application/wasm" to "wasm"),
  "webp" to ("image/webp" to "image"),
  "woff2" to ("font/woff2" to "font")
)

private data class MobileWebAssetRecord(
  val path: String,
  val sha256: String,
  val byteLength: Int,
  val contentType: String,
  val role: String
)

private data class MobileWebManifestRecord(
  val buildId: String,
  val bridgeMinimum: Int,
  val bridgeTestedThrough: Int,
  val entrypoint: String,
  val assets: Map<String, MobileWebAssetRecord>
)

internal data class MobileWebAssetResponse(
  val bytes: ByteArray,
  val contentType: String,
  val isDocument: Boolean
)

private data class MobileWebSessionRecord(
  val hostKey: String,
  val buildId: String,
  val root: File,
  val manifest: MobileWebManifestRecord
)

internal class MobileWebPackageStore internal constructor(
  private val cacheRoot: File,
  private val decodeBase64: (String) -> ByteArray = ::decodeAndroidBase64,
  private val encodeBase64: (ByteArray) -> String = ::encodeAndroidBase64
) {
  internal constructor(context: Context) : this(File(context.noBackupFilesDir, "OrcaMobileWeb"))

  private val sessions = mutableMapOf<String, MobileWebSessionRecord>()

  init {
    runCatching {
      require(cacheRoot.mkdirs() || cacheRoot.isDirectory) { "mobile_web_cache_create_failed" }
      discardAllStagedGenerations()
    }
  }

  /** Writes one complete asset. JS has already reassembled and sha256-verified the bytes. */
  @Synchronized
  fun writeStagedAsset(hostIdentity: String, buildId: String, path: String, dataBase64: String) {
    val hostKey = validatedHostKey(hostIdentity)
    require(
      isMobileWebSha256(buildId) &&
        isSafeMobileWebAssetPath(path) &&
        path != MANIFEST_FILE_NAME &&
        dataBase64.length <= ASSET_BASE64_CHARACTER_LIMIT
    ) { "mobile_web_staged_asset_invalid" }
    val bytes = try {
      decodeBase64(dataBase64)
    } catch (_: IllegalArgumentException) {
      throw IllegalArgumentException("mobile_web_staged_asset_invalid")
    }
    require(
      bytes.isNotEmpty() && bytes.size <= ASSET_BYTE_LIMIT && encodeBase64(bytes) == dataBase64
    ) { "mobile_web_staged_asset_invalid" }
    val stageRoot = createdStagingRoot(hostKey, buildId)
    val file = assetFile(stageRoot, path)
    try {
      val parent = requireNotNull(file.parentFile) { "mobile_web_staged_write_failed" }
      require(parent.mkdirs() || parent.isDirectory) { "mobile_web_staged_write_failed" }
      require(isMobileWebUnlinkedPath(parent, cacheRoot)) { "mobile_web_staged_write_failed" }
      // Replacing the slot rather than writing into it keeps a symlinked name from being followed.
      file.delete()
      FileOutputStream(file).use { it.write(bytes) }
      require(isMobileWebUnlinkedPath(file, cacheRoot)) { "mobile_web_staged_write_failed" }
    } catch (error: Exception) {
      throw storageException(error, "mobile_web_staged_write_failed")
    }
  }

  /** Promotes the staged tree to the host's only generation once every manifest asset verifies. */
  @Synchronized
  fun commitGeneration(hostIdentity: String, buildId: String, manifestJson: String): String {
    val hostKey = validatedHostKey(hostIdentity)
    val manifest = parseManifest(buildId, manifestJson)
    val hostRoot = File(cacheRoot, hostKey)
    val generations = File(hostRoot, "generations")
    val destination = File(generations, buildId)
    val stageRoot = stagingRoot(hostRoot, buildId)
    require(
      isMobileWebUnlinkedPath(hostRoot, cacheRoot) &&
        isMobileWebUnlinkedPath(generations, cacheRoot) &&
        isMobileWebUnlinkedPath(destination, cacheRoot) &&
        isMobileWebUnlinkedPath(stageRoot, cacheRoot)
    ) { "mobile_web_generation_commit_failed" }
    if (runCatching { verifyGeneration(destination, buildId) }.isFailure) {
      promoteStagedGeneration(stageRoot, destination, generations, manifest, manifestJson)
    }
    runCatching { removeMobileWebCacheTree(stageRoot, cacheRoot) }
    runCatching { removeOtherGenerations(generations, hostKey, buildId) }
    runCatching { evictLeastRecentlyActivatedHosts(hostKey) }
    return buildId
  }

  @Synchronized
  fun abortGeneration(hostIdentity: String, buildId: String) {
    runCatching {
      val hostKey = validatedHostKey(hostIdentity)
      require(isMobileWebSha256(buildId)) { "mobile_web_staged_asset_invalid" }
      removeMobileWebCacheTree(stagingRoot(File(cacheRoot, hostKey), buildId), cacheRoot)
    }
  }

  @Synchronized
  fun openSession(hostIdentity: String, buildId: String?, bridgeVersion: Int): Map<String, String> {
    val hostKey = validatedHostKey(hostIdentity)
    val hostRoot = File(cacheRoot, hostKey)
    val generations = File(hostRoot, "generations")
    require(
      isMobileWebUnlinkedPath(hostRoot, cacheRoot) &&
        isMobileWebUnlinkedPath(generations, cacheRoot)
    ) { "mobile_web_generation_invalid" }
    val selectedBuildId = requestedBuildId(generations, buildId)
    val generationRoot = File(generations, selectedBuildId)
    require(isMobileWebUnlinkedPath(generationRoot, cacheRoot)) { "mobile_web_generation_invalid" }
    val manifest = verifyGeneration(generationRoot, selectedBuildId)
    require(bridgeVersion in manifest.bridgeMinimum..manifest.bridgeTestedThrough) {
      "mobile_web_bridge_incompatible"
    }
    // The host directory's modification time is the only activation record the LRU cap needs.
    hostRoot.setLastModified(System.currentTimeMillis())
    val sessionId = randomIdentifier()
    sessions[sessionId] = MobileWebSessionRecord(
      hostKey,
      selectedBuildId,
      generationRoot,
      manifest
    )
    return mapOf(
      "sessionId" to sessionId,
      "buildId" to selectedBuildId,
      "url" to "${mobileWebOriginForSession(sessionId)}/#$sessionId"
    )
  }

  @Synchronized
  fun closeSession(sessionId: String) {
    val session = sessions.remove(sessionId) ?: return
    runCatching {
      val generations = File(File(cacheRoot, session.hostKey), "generations")
      removeOtherGenerations(generations, session.hostKey, requestedBuildId(generations, null))
    }
  }

  @Synchronized
  fun readAsset(sessionId: String, path: String): MobileWebAssetResponse {
    val session = sessions[sessionId]
      ?: throw IllegalArgumentException("mobile_web_asset_unavailable")
    val asset = session.manifest.assets[path]
      ?: throw IllegalArgumentException("mobile_web_asset_unavailable")
    return MobileWebAssetResponse(
      verifiedAssetBytes(session.root, asset),
      asset.contentType,
      asset.role == "document"
    )
  }

  @Synchronized
  fun removeHost(hostIdentity: String) {
    val hostKey = validatedHostKey(hostIdentity)
    sessions.entries.removeAll { it.value.hostKey == hostKey }
    require(removeMobileWebCacheTree(File(cacheRoot, hostKey), cacheRoot)) {
      "mobile_web_host_cleanup_failed"
    }
  }

  private fun promoteStagedGeneration(
    stageRoot: File,
    destination: File,
    generations: File,
    manifest: MobileWebManifestRecord,
    manifestJson: String
  ) {
    requireExactStagedTree(stageRoot, manifest)
    try {
      val manifestFile = File(stageRoot, MANIFEST_FILE_NAME)
      manifestFile.delete()
      FileOutputStream(manifestFile).use {
        it.write(manifestJson.toByteArray(Charsets.UTF_8))
        it.fd.sync()
      }
      require(generations.mkdirs() || generations.isDirectory) {
        "mobile_web_generation_commit_failed"
      }
      require(isMobileWebUnlinkedPath(generations, cacheRoot)) {
        "mobile_web_generation_commit_failed"
      }
      if (destination.exists()) {
        require(removeMobileWebCacheTree(destination, cacheRoot)) {
          "mobile_web_generation_commit_failed"
        }
      }
      require(stageRoot.renameTo(destination)) { "mobile_web_generation_commit_failed" }
      require(isMobileWebUnlinkedPath(destination, cacheRoot)) {
        "mobile_web_generation_commit_failed"
      }
    } catch (error: Exception) {
      throw storageException(error, "mobile_web_generation_commit_failed")
    }
  }

  /** A staged tree carrying anything the manifest does not name would survive the rename. */
  private fun requireExactStagedTree(stageRoot: File, manifest: MobileWebManifestRecord) {
    require(isMobileWebUnlinkedPath(stageRoot, cacheRoot) && stageRoot.isDirectory) {
      "mobile_web_staged_generation_incomplete"
    }
    require(stagedRelativePaths(stageRoot, "") == manifest.assets.keys) {
      "mobile_web_staged_generation_incomplete"
    }
    for (asset in manifest.assets.values) {
      verifiedAssetBytes(stageRoot, asset)
    }
  }

  private fun stagedRelativePaths(root: File, prefix: String): Set<String> {
    val children = requireNotNull(root.listFiles()) { "mobile_web_staged_generation_incomplete" }
    return children.flatMapTo(mutableSetOf()) { child ->
      if (child.isDirectory) {
        stagedRelativePaths(child, "$prefix${child.name}/")
      } else {
        listOf("$prefix${child.name}")
      }
    }
  }

  private fun verifiedAssetBytes(root: File, asset: MobileWebAssetRecord): ByteArray {
    val bytes = try {
      readMobileWebFile(
        assetFile(root, asset.path),
        cacheRoot,
        asset.byteLength,
        "mobile_web_generation_invalid"
      )
    } catch (_: Exception) {
      throw IllegalArgumentException("mobile_web_generation_invalid")
    }
    require(bytes.size == asset.byteLength && sha256Hex(bytes) == asset.sha256) {
      "mobile_web_generation_invalid"
    }
    return bytes
  }

  private fun verifyGeneration(root: File, buildId: String): MobileWebManifestRecord = try {
    val manifest = parseManifest(
      buildId,
      readMobileWebFile(
        File(root, MANIFEST_FILE_NAME),
        cacheRoot,
        MANIFEST_JSON_BYTE_LIMIT,
        "mobile_web_generation_invalid"
      ).toString(Charsets.UTF_8)
    )
    manifest.assets.values.forEach { verifiedAssetBytes(root, it) }
    manifest
  } catch (_: Exception) {
    throw IllegalArgumentException("mobile_web_generation_invalid")
  }

  /**
   * The build id is the sha256 of these exact manifest bytes, so the directory name authenticates
   * the manifest and the manifest authenticates every asset.
   */
  private fun parseManifest(buildId: String, manifestJson: String): MobileWebManifestRecord {
    require(
      isMobileWebSha256(buildId) &&
        manifestJson.toByteArray(Charsets.UTF_8).size <= MANIFEST_JSON_BYTE_LIMIT &&
        sha256Hex(manifestJson.toByteArray(Charsets.UTF_8)) == buildId
    ) { "mobile_web_manifest_invalid" }
    val manifest = try {
      JSONObject(manifestJson)
    } catch (_: Exception) {
      throw IllegalArgumentException("mobile_web_manifest_invalid")
    }
    require(
      manifest.keys().asSequence().toSet() ==
        setOf("schemaVersion", "bridge", "entrypoint", "totalBytes", "assets") &&
        strictJsonInt(manifest, "schemaVersion") == 1
    ) { "mobile_web_manifest_invalid" }
    val bridge = manifest.opt("bridge") as? JSONObject
      ?: throw IllegalArgumentException("mobile_web_manifest_invalid")
    val bridgeMinimum = strictJsonInt(bridge, "minimum") ?: -1
    val bridgeTestedThrough = strictJsonInt(bridge, "testedThrough") ?: -1
    val entrypoint = strictJsonString(manifest, "entrypoint") ?: ""
    val declaredTotalBytes = strictJsonInt(manifest, "totalBytes") ?: -1
    require(
      bridge.keys().asSequence().toSet() == setOf("minimum", "testedThrough") &&
        bridgeMinimum > 0 &&
        bridgeMinimum <= bridgeTestedThrough &&
        bridgeTestedThrough <= 65_535 &&
        declaredTotalBytes in 1..(32 * 1024 * 1024)
    ) { "mobile_web_manifest_invalid" }
    val assetValues = manifest.opt("assets") as? JSONArray
      ?: throw IllegalArgumentException("mobile_web_manifest_invalid")
    require(assetValues.length() in 1..256) { "mobile_web_manifest_invalid" }
    val assets = parsedAssets(assetValues)
    require(
      assets.values.sumOf { it.byteLength } == declaredTotalBytes &&
        assets.values.count { it.role == "document" } in 1..MOBILE_WEB_DOCUMENT_PATHS.size &&
        entrypoint == "index.html" &&
        assets[entrypoint]?.role == "document"
    ) { "mobile_web_manifest_invalid" }
    return MobileWebManifestRecord(
      buildId,
      bridgeMinimum,
      bridgeTestedThrough,
      entrypoint,
      assets
    )
  }

  private fun parsedAssets(assetValues: JSONArray): Map<String, MobileWebAssetRecord> {
    val assets = mutableMapOf<String, MobileWebAssetRecord>()
    var previousPath: String? = null
    for (index in 0 until assetValues.length()) {
      val value = assetValues.opt(index) as? JSONObject
        ?: throw IllegalArgumentException("mobile_web_manifest_invalid")
      require(
        value.keys().asSequence().toSet() ==
          setOf("path", "sha256", "byteLength", "contentType", "role")
      ) { "mobile_web_manifest_invalid" }
      val path = strictJsonString(value, "path") ?: ""
      val hash = strictJsonString(value, "sha256") ?: ""
      val length = strictJsonInt(value, "byteLength") ?: -1
      val contentType = strictJsonString(value, "contentType") ?: ""
      val role = strictJsonString(value, "role") ?: ""
      require(
        length in 1..ASSET_BYTE_LIMIT &&
          path !in assets &&
          (previousPath?.let { it < path } ?: true) &&
          isValidMobileWebAssetMetadata(path, hash, contentType, role)
      ) { "mobile_web_manifest_invalid" }
      assets[path] = MobileWebAssetRecord(path, hash, length, contentType, role)
      previousPath = path
    }
    return assets
  }

  private fun requestedBuildId(generations: File, buildId: String?): String {
    if (buildId != null) {
      require(isMobileWebSha256(buildId)) { "mobile_web_generation_invalid" }
      return buildId
    }
    val newest = generations.listFiles()
      ?.filter { isMobileWebSha256(it.name) }
      ?.maxByOrNull { it.lastModified() }
      ?: throw IllegalArgumentException("mobile_web_generation_invalid")
    return newest.name
  }

  private fun removeOtherGenerations(generations: File, hostKey: String, buildId: String) {
    val retained = sessions.values
      .filter { it.hostKey == hostKey }
      .mapTo(mutableSetOf()) { it.buildId } + buildId
    generations.listFiles()?.forEach { child ->
      if (child.name !in retained) {
        require(removeMobileWebCacheTree(child, cacheRoot)) {
          "mobile_web_generation_cleanup_failed"
        }
      }
    }
  }

  private fun evictLeastRecentlyActivatedHosts(hostKey: String) {
    val live = sessions.values.mapTo(mutableSetOf()) { it.hostKey } + hostKey
    val hostRoots = cacheRoot.listFiles()?.filter { isMobileWebSha256(it.name) }.orEmpty()
    val overflow = hostRoots.size - MAXIMUM_CACHED_HOSTS
    if (overflow <= 0) return
    hostRoots
      .filter { it.name !in live }
      .sortedBy { it.lastModified() }
      .take(overflow)
      .forEach {
        require(removeMobileWebCacheTree(it, cacheRoot)) { "mobile_web_cache_cleanup_failed" }
      }
  }

  private fun discardAllStagedGenerations() {
    cacheRoot.listFiles()
      ?.filter { isMobileWebSha256(it.name) }
      ?.forEach { hostRoot ->
        val removed = if (isMobileWebUnlinkedPath(hostRoot, cacheRoot)) {
          removeMobileWebCacheTree(File(hostRoot, STAGING_DIRECTORY_NAME), cacheRoot)
        } else {
          removeMobileWebCacheTree(hostRoot, cacheRoot)
        }
        require(removed) { "mobile_web_cache_cleanup_failed" }
      }
  }

  private fun createdStagingRoot(hostKey: String, buildId: String): File {
    val hostRoot = File(cacheRoot, hostKey)
    val staging = File(hostRoot, STAGING_DIRECTORY_NAME)
    val stageRoot = File(staging, buildId)
    // mkdirs() would create the stage *through* a symlinked ancestor before any later check
    // could reject it, so the ancestors are validated first.
    require(
      isMobileWebUnlinkedPath(hostRoot, cacheRoot) &&
        isMobileWebUnlinkedPath(staging, cacheRoot) &&
        isMobileWebUnlinkedPath(stageRoot, cacheRoot)
    ) { "mobile_web_staged_write_failed" }
    require(stageRoot.mkdirs() || stageRoot.isDirectory) { "mobile_web_staged_write_failed" }
    require(isMobileWebUnlinkedPath(stageRoot, cacheRoot)) { "mobile_web_staged_write_failed" }
    return stageRoot
  }

  private fun stagingRoot(hostRoot: File, buildId: String): File =
    File(File(hostRoot, STAGING_DIRECTORY_NAME), buildId)

  private fun validatedHostKey(hostIdentity: String): String {
    val bytes = hostIdentity.toByteArray(Charsets.UTF_8)
    require(bytes.isNotEmpty() && bytes.size <= 8 * 1024) { "mobile_web_host_identity_invalid" }
    return sha256Hex(bytes)
  }

  private fun randomIdentifier(): String {
    val bytes = ByteArray(32)
    SecureRandom().nextBytes(bytes)
    return encodeBase64(bytes)
      .replace('+', '-')
      .replace('/', '_')
      .trimEnd('=')
  }
}

internal object MobileWebShellEnvironment {
  @Volatile
  private var packageStore: MobileWebPackageStore? = null

  fun packageStore(context: Context): MobileWebPackageStore =
    packageStore ?: synchronized(this) {
      packageStore ?: MobileWebPackageStore(context.applicationContext).also { packageStore = it }
    }
}

private fun assetFile(root: File, path: String): File =
  path.split('/').fold(root) { parent, component -> File(parent, component) }

internal fun isSafeMobileWebAssetPath(path: String): Boolean =
  path.length in 1..240 &&
    !path.startsWith('/') &&
    !path.endsWith('/') &&
    !path.contains("//") &&
    !path.contains('\\') &&
    !path.contains('?') &&
    !path.contains('#') &&
    SAFE_PATH_PATTERN.matches(path) &&
    path.split('/').all { it != "." && it != ".." }

internal fun isMobileWebSha256(value: String): Boolean = SHA256_PATTERN.matches(value)

private val MOBILE_WEB_DOCUMENT_PATHS =
  setOf("index.html", "markdown-editor.html", "mermaid-frame.html")

internal fun isValidMobileWebAssetMetadata(
  path: String,
  hash: String,
  contentType: String,
  role: String
): Boolean {
  if (!isSafeMobileWebAssetPath(path) || !isMobileWebSha256(hash)) return false
  if (role == "document") {
    return path in MOBILE_WEB_DOCUMENT_PATHS && contentType == "text/html; charset=utf-8"
  }
  val components = path.split('/')
  if (components.size != 2 || components[0] != "assets") return false
  val separator = components[1].lastIndexOf('.')
  if (separator <= 0) return false
  val fileHash = components[1].substring(0, separator)
  val extension = components[1].substring(separator + 1)
  val expectedMetadata = ASSET_METADATA_BY_EXTENSION[extension] ?: return false
  return fileHash == hash && expectedMetadata.first == contentType && expectedMetadata.second == role
}

private fun strictJsonInt(value: JSONObject, key: String): Int? = value.opt(key) as? Int

private fun strictJsonString(value: JSONObject, key: String): String? = value.opt(key) as? String

private fun sha256Hex(bytes: ByteArray): String =
  MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }

private fun decodeAndroidBase64(value: String): ByteArray = Base64.decode(value, Base64.NO_WRAP)

private fun encodeAndroidBase64(bytes: ByteArray): String =
  Base64.encodeToString(bytes, Base64.NO_WRAP)

private fun storageException(error: Exception, fallback: String): IllegalArgumentException {
  if (error is IllegalArgumentException && error.message?.startsWith("mobile_web_") == true) {
    return error
  }
  return IllegalArgumentException(
    if (isStorageUnavailable(error)) "mobile_web_cache_storage_unavailable" else fallback
  )
}

private fun isStorageUnavailable(error: Throwable?): Boolean {
  if (error == null) return false
  if (error is IOException && error.message?.contains("ENOSPC", ignoreCase = true) == true) {
    return true
  }
  return isStorageUnavailable(error.cause)
}
