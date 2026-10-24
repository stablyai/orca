package expo.modules.orcaappupdater

import android.content.Context
import android.content.pm.PackageInfo
import android.content.pm.PackageManager
import android.os.Build
import androidx.core.content.pm.PackageInfoCompat
import java.io.File
import java.io.InputStream
import java.io.OutputStream
import java.security.MessageDigest

internal fun copyVerifiedApk(
  input: InputStream,
  output: OutputStream,
  expectedSize: Long,
  sha256: String,
  checkCancelled: () -> Unit,
  progress: (Long) -> Unit
) {
  require(expectedSize in 1..MAX_APK_BYTES) { "The APK size is invalid." }
  val digest = MessageDigest.getInstance("SHA-256")
  val buffer = ByteArray(64 * 1024)
  var count = 0L
  while (true) {
    checkCancelled()
    val read = input.read(buffer)
    if (read < 0) break
    count += read
    require(count <= expectedSize) { "The download is larger than the release APK." }
    digest.update(buffer, 0, read)
    output.write(buffer, 0, read)
    progress(count)
  }
  checkCancelled()
  require(count == expectedSize) { "The download is incomplete. Try again." }
  val actual = digest.digest().joinToString("") { "%02x".format(it) }
  require(actual == sha256) { "The APK checksum does not match this release. Try again." }
}

internal const val MAX_APK_BYTES = 512L * 1024 * 1024

internal fun verifyApkIdentity(context: Context, file: File, version: String) {
  val pm = context.packageManager
  val flags = if (Build.VERSION.SDK_INT >= 28) {
    PackageManager.GET_SIGNING_CERTIFICATES
  } else {
    PackageManager.GET_SIGNATURES
  }
  val archive = pm.getPackageArchiveInfo(file.absolutePath, flags)
    ?: error("Android could not read this APK.")
  val installed = pm.getPackageInfo(context.packageName, flags)
  require(archive.packageName == context.packageName) { "This APK is for a different app." }
  require(
    archive.versionName == version &&
      isNewerVersion(version, installed.versionName) &&
      PackageInfoCompat.getLongVersionCode(archive) >= PackageInfoCompat.getLongVersionCode(installed)
  ) {
    "This APK is not a newer version of your installed app."
  }
  require(archive.applicationInfo?.minSdkVersion?.let { it <= Build.VERSION.SDK_INT } == true) {
    "This update needs a newer Android version."
  }
  val signers = currentSigners(installed)
  require(signers.isNotEmpty() && currentSigners(archive) == signers) {
    "This APK uses a different signing certificate. Open the release page for installation options."
  }
}

internal fun isNewerVersion(candidate: String, installed: String?): Boolean {
  fun parts(value: String?): List<Long>? {
    if (value == null || !value.matches(Regex("\\d+\\.\\d+\\.\\d+"))) return null
    return value.split('.').map { it.toLongOrNull() ?: return null }
  }
  val next = parts(candidate) ?: return false
  val current = parts(installed) ?: return false
  return next.zip(current).firstOrNull { (a, b) -> a != b }?.let { (a, b) -> a > b } ?: false
}

private fun currentSigners(info: PackageInfo): Set<String> {
  val signatures = if (Build.VERSION.SDK_INT >= 28) {
    info.signingInfo?.apkContentsSigners
  } else {
    info.signatures
  }
  return signatures?.map { signature ->
    MessageDigest.getInstance("SHA-256").digest(signature.toByteArray())
      .joinToString("") { "%02x".format(it) }
  }?.toSet() ?: emptySet()
}
