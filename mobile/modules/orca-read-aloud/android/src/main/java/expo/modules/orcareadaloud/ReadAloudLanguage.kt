package expo.modules.orcareadaloud

import android.content.Context
import android.os.Build
import android.view.textclassifier.TextClassificationManager
import android.view.textclassifier.TextLanguage

/** On-device language detection (Android 10+), so a sentence in another language gets its own voice. */
object ReadAloudLanguage {
  /** (language tag, confidence 0–1) of the likeliest language per text; null where unknown. */
  fun detect(context: Context, texts: List<String>): List<Map<String, Any>?> {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) return texts.map { null }
    val classifier = runCatching {
      context.getSystemService(TextClassificationManager::class.java)?.textClassifier
    }.getOrNull() ?: return texts.map { null }
    return texts.map { text ->
      runCatching {
        val result = classifier.detectLanguage(TextLanguage.Request.Builder(text).build())
        (0 until result.localeHypothesisCount)
          .map { result.getLocale(it) }
          .maxByOrNull { result.getConfidenceScore(it) }
          ?.let { locale ->
            mapOf(
              "language" to locale.toLanguageTag(),
              "confidence" to result.getConfidenceScore(locale).toDouble()
            )
          }
      }.getOrNull()
    }
  }
}
