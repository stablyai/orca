package expo.modules.mobilewebshell

import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.security.MessageDigest
import java.util.Base64

/**
 * The manifest bytes are the canonical document whose sha256 is the build id, so a test that mutates
 * the manifest must re-derive the id the same way the desktop does.
 */
internal data class MobileWebStoreFixture(
  val bytes: ByteArray,
  val manifestJson: String,
  val buildId: String
)

internal fun jvmMobileWebPackageStore(cacheRoot: File): MobileWebPackageStore =
  MobileWebPackageStore(
    cacheRoot,
    decodeBase64 = { Base64.getDecoder().decode(it) },
    encodeBase64 = { Base64.getEncoder().encodeToString(it) }
  )

internal fun mobileWebStoreFixture(
  content: String = "<!doctype html><title>Orca</title>",
  mutate: (JSONObject) -> Unit = {}
): MobileWebStoreFixture {
  val bytes = content.toByteArray(Charsets.UTF_8)
  val asset = JSONObject()
    .put("path", "index.html")
    .put("sha256", mobileWebStoreSha256Hex(bytes))
    .put("byteLength", bytes.size)
    .put("contentType", "text/html; charset=utf-8")
    .put("role", "document")
  val manifest = JSONObject()
    .put("schemaVersion", 1)
    .put("bridge", JSONObject().put("minimum", 1).put("testedThrough", 1))
    .put("entrypoint", "index.html")
    .put("totalBytes", bytes.size)
    .put("assets", JSONArray().put(asset))
  mutate(manifest)
  return mobileWebStoreFixtureOf(bytes, manifest.toString())
}

internal fun mobileWebStoreFixtureOf(bytes: ByteArray, manifestJson: String): MobileWebStoreFixture =
  MobileWebStoreFixture(
    bytes,
    manifestJson,
    mobileWebStoreSha256Hex(manifestJson.toByteArray(Charsets.UTF_8))
  )

internal fun MobileWebPackageStore.stageAsset(host: String, fixture: MobileWebStoreFixture) {
  writeStagedAsset(
    host,
    fixture.buildId,
    "index.html",
    Base64.getEncoder().encodeToString(fixture.bytes)
  )
}

internal fun MobileWebPackageStore.commitFixture(host: String, fixture: MobileWebStoreFixture) {
  stageAsset(host, fixture)
  require(commitGeneration(host, fixture.buildId, fixture.manifestJson) == fixture.buildId)
}

internal fun mobileWebStoreHostRoot(cacheRoot: File, host: String): File =
  File(cacheRoot, mobileWebStoreSha256Hex(host.toByteArray(Charsets.UTF_8)))

internal fun mobileWebStoreGenerations(cacheRoot: File, host: String): File =
  File(mobileWebStoreHostRoot(cacheRoot, host), "generations")

internal fun mobileWebStoreStagingRoot(cacheRoot: File, host: String, buildId: String): File =
  File(File(mobileWebStoreHostRoot(cacheRoot, host), "tmp"), buildId)

internal fun mobileWebStoreSha256Hex(bytes: ByteArray): String =
  MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }
