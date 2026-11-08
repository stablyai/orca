package expo.modules.orcamobilewebshell

import android.app.Activity
import android.content.ClipData
import android.content.ContentValues
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.provider.MediaStore
import android.webkit.MimeTypeMap
import expo.modules.kotlin.exception.CodedException

/** Takes a FileProvider content:// URI; the clip and flag let the chooser preview and the chosen app read it. */
internal fun presentImageShareSheet(activity: Activity, uri: Uri, mime: String) {
  val send = Intent(Intent.ACTION_SEND).apply {
    type = mime
    putExtra(Intent.EXTRA_STREAM, uri)
    clipData = ClipData.newRawUri(null, uri)
    addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
  }
  activity.startActivity(Intent.createChooser(send, null))
}

/** Copies the image into Pictures/Orca. MediaStore needs no permission for this from Android 10; older versions would need storage access Orca does not ask for. */
internal fun saveImageToGallery(context: Context, uri: Uri, mime: String) {
  if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) {
    throw CodedException("native_verb_failed", "Saving images needs Android 10 or later", null)
  }
  val extension = MimeTypeMap.getSingleton().getExtensionFromMimeType(mime)
  val name = "Orca ${System.currentTimeMillis()}" + (extension?.let { ".$it" } ?: "")
  val resolver = context.contentResolver
  val pending = ContentValues().apply {
    put(MediaStore.MediaColumns.DISPLAY_NAME, name)
    put(MediaStore.MediaColumns.MIME_TYPE, mime)
    put(MediaStore.MediaColumns.RELATIVE_PATH, "${Environment.DIRECTORY_PICTURES}/Orca")
    put(MediaStore.MediaColumns.IS_PENDING, 1)
  }
  val target = resolver.insert(
    MediaStore.Images.Media.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY),
    pending
  ) ?: throw CodedException("native_verb_failed", "The gallery refused the image", null)
  try {
    val input = resolver.openInputStream(uri) ?: throw IllegalStateException("the image file is gone")
    input.use { source ->
      val output = resolver.openOutputStream(target) ?: throw IllegalStateException("the gallery entry is not writable")
      output.use { source.copyTo(it) }
    }
    resolver.update(target, ContentValues().apply { put(MediaStore.MediaColumns.IS_PENDING, 0) }, null, null)
  } catch (error: Exception) {
    resolver.delete(target, null, null)
    throw CodedException("native_verb_failed", "Could not save the image", error)
  }
}
