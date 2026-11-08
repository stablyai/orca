package expo.modules.twowayaudio

import android.icu.util.ULocale
import java.util.Locale

// Locales to ask the recognizer about, best first. Recognizers key on language-region ("en-US") and
// report every tag with Unicode extensions unavailable, which Android adds for regional preferences
// such as the temperature unit (en-US-u-mu-celsius).
internal fun speechLocaleCandidates(requested: String, system: Locale): List<Locale> {
  val tag = requested.trim()
  val base = (if (tag.isEmpty() || tag == "auto") system else Locale.forLanguageTag(tag))
    .stripExtensions()
  if (base.language.isEmpty()) return emptyList()
  if (base.country.isNotEmpty()) return listOf(base)
  val likely = ULocale.addLikelySubtags(ULocale.forLocale(base))
  if (likely.country.isEmpty()) return listOf(base)
  val regional = Locale.Builder()
    .setLanguage(base.language)
    // Chinese needs its script to tell Simplified from Traditional; other languages are keyed without it.
    .setScript(if (base.language == "zh") likely.script else base.script)
    .setRegion(likely.country)
    .build()
  return listOf(regional, base)
}
