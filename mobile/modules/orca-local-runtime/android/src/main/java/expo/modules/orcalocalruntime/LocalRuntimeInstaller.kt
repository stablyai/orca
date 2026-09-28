package expo.modules.orcalocalruntime

import android.content.Context
import org.json.JSONObject
import java.io.File
import java.io.FileInputStream
import java.io.FileOutputStream
import java.io.InputStream
import java.io.OutputStream
import java.net.HttpURLConnection
import java.net.URL
import java.security.MessageDigest

data class LocalRuntimeInstallOptions(
  val rootfsUrl: String = DEFAULT_ROOTFS_URL,
  val rootfsSha256: String = DEFAULT_ROOTFS_SHA256,
  /** A .tar.gz of the `build:orcad --target linux-arm64-glibc` output directory. */
  val orcadBundleUrl: String?,
  val orcadBundleSha256: String?,
  val aptPackages: List<String> = DEFAULT_APT_PACKAGES,
  val reinstallRootfs: Boolean = false
) {
  companion object {
    const val DEFAULT_ROOTFS_URL =
      "https://cdimage.ubuntu.com/ubuntu-base/releases/24.04/release/ubuntu-base-24.04.5-base-arm64.tar.gz"
    const val DEFAULT_ROOTFS_SHA256 = "a91d5a93010193712d346d761372b7c9db6dfcf093893161c64ca107f05914f2"
    // git + procps are what orcad shells out to; the rest keep agent CLIs installable over TLS.
    val DEFAULT_APT_PACKAGES = listOf("git", "procps", "ca-certificates", "curl", "unzip", "openssh-client")
  }
}

class LocalRuntimeInstaller(private val context: Context, private val paths: LocalRuntimePaths) {
  fun isInstalled(): Boolean =
    paths.installRecord.isFile && paths.prootBinary.canExecute() && File(paths.orcadDir, "orcad.js").isFile

  fun install(options: LocalRuntimeInstallOptions, onStep: (String) -> Unit) {
    listOf(paths.root, paths.prootTmp, paths.downloads).forEach { it.mkdirs() }

    onStep("proot")
    installProot()

    if (options.reinstallRootfs || !File(paths.rootfs, "usr/bin/env").exists()) {
      onStep("rootfs-download")
      val tarball = download(options.rootfsUrl, options.rootfsSha256, File(paths.downloads, "rootfs.tar.gz"))
      onStep("rootfs-extract")
      paths.rootfs.deleteRecursively()
      FileInputStream(tarball).use { TarGzExtractor.extract(it, paths.rootfs) }
      tarball.delete()
      writeGuestNetworkConfig()
    }

    onStep("packages")
    runGuest(
      listOf(
        "/bin/sh", "-c",
        "apt-get update -q && apt-get install -y -q --no-install-recommends ${options.aptPackages.joinToString(" ")} && apt-get clean && rm -rf /var/lib/apt/lists/*"
      ),
      "apt"
    )

    onStep("orcad")
    val bundleUrl = options.orcadBundleUrl ?: throw IllegalArgumentException("orcadBundleUrl is required")
    val bundle = fetch(bundleUrl, options.orcadBundleSha256, File(paths.downloads, "orcad.tar.gz"))
    paths.orcadDir.deleteRecursively()
    FileInputStream(bundle).use { TarGzExtractor.extract(it, paths.orcadDir) }
    if (bundle.parentFile == paths.downloads) bundle.delete()

    paths.installRecord.writeText(
      JSONObject()
        .put("rootfsUrl", options.rootfsUrl)
        .put("orcadBundleUrl", bundleUrl)
        .put("installedAt", System.currentTimeMillis())
        .toString()
    )
    onStep("done")
  }

  /** Also run before every host start, so an app update's proot fixes apply without a reinstall. */
  fun installProot() {
    paths.prootBinary.parentFile?.mkdirs()
    for ((asset, target) in listOf("proot" to paths.prootBinary, "loader" to paths.prootLoader)) {
      // Write-then-rename: overwriting a binary a running host still maps fails with ETXTBSY.
      val staging = File(target.path + ".new")
      context.assets.open("orca-local-runtime/$asset").use { input ->
        FileOutputStream(staging).use { input.copyTo(it) }
      }
      staging.setExecutable(true, true)
      if (!staging.renameTo(target)) throw IllegalStateException("Could not install $asset")
    }
  }

  private fun writeGuestNetworkConfig() {
    // Android has no /etc/resolv.conf to bind, so the guest gets public resolvers.
    File(paths.rootfs, "etc/resolv.conf").apply {
      delete()
      writeText("nameserver 8.8.8.8\nnameserver 1.1.1.1\n")
    }
    File(paths.rootfs, "etc/hosts").writeText("127.0.0.1 localhost\n::1 localhost ip6-localhost\n")
  }

  private fun runGuest(guestArgv: List<String>, tag: String) {
    val process = ProcessBuilder(ProotCommand.argv(paths, guestArgv))
      .redirectErrorStream(true)
      .apply { environment().putAll(ProotCommand.hostEnv(paths)) }
      .start()
    process.inputStream.bufferedReader().forEachLine { LocalRuntimeState.appendLog("[$tag] $it") }
    val code = process.waitFor()
    if (code != 0) throw IllegalStateException("$tag exited with code $code")
  }

  /**
   * `file://` sources are for development (an adb-pushed bundle in the app's external files dir) and
   * are verified in place rather than copied: phones this runs on are often short on space.
   */
  private fun fetch(url: String, sha256: String?, destination: File): File {
    if (!url.startsWith("file://")) return download(url, sha256, destination)
    val source = File(url.removePrefix("file://"))
    if (sha256 != null) {
      val actual = FileInputStream(source).use { sha256Hex(it, null) }
      check(actual.equals(sha256, ignoreCase = true)) { "Checksum mismatch for $url: $actual" }
    }
    return source
  }

  private fun sha256Hex(input: InputStream, copyTo: OutputStream?): String {
    val digest = MessageDigest.getInstance("SHA-256")
    val buffer = ByteArray(DEFAULT_BUFFER_SIZE * 8)
    while (true) {
      val read = input.read(buffer)
      if (read < 0) break
      digest.update(buffer, 0, read)
      copyTo?.write(buffer, 0, read)
    }
    return digest.digest().joinToString("") { "%02x".format(it) }
  }

  private fun download(url: String, sha256: String?, destination: File): File {
    val connection = URL(url).openConnection() as HttpURLConnection
    connection.instanceFollowRedirects = true
    connection.connectTimeout = 30_000
    connection.readTimeout = 60_000
    if (connection.responseCode !in 200..299) {
      throw IllegalStateException("Download failed (${connection.responseCode}): $url")
    }
    val actual = connection.inputStream.use { stream ->
      FileOutputStream(destination).use { out -> sha256Hex(stream, out) }
    }
    if (sha256 != null && !actual.equals(sha256, ignoreCase = true)) {
      destination.delete()
      throw IllegalStateException("Checksum mismatch for $url: $actual")
    }
    return destination
  }
}
