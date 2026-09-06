package expo.modules.mobilewebshell

internal const val MOBILE_WEB_PER_HOST_CACHE_BYTE_LIMIT = 128L * 1024 * 1024
internal const val MOBILE_WEB_GLOBAL_CACHE_BYTE_LIMIT = 512L * 1024 * 1024
internal const val MOBILE_WEB_MINIMUM_FREE_STORAGE_BYTES = 16L * 1024 * 1024

internal data class MobileWebCacheGenerationCandidate(
  val hostKey: String,
  val buildId: String,
  val byteLength: Long,
  val modifiedAtMillis: Long,
  val root: java.io.File
)

internal fun mobileWebCacheEvictionPlan(
  candidates: List<MobileWebCacheGenerationCandidate>,
  targetHostKey: String,
  projectedHostBytes: Long,
  projectedGlobalBytes: Long
): List<MobileWebCacheGenerationCandidate>? {
  val remaining = candidates.toMutableList()
  val selected = mutableListOf<MobileWebCacheGenerationCandidate>()
  var hostBytes = projectedHostBytes
  var globalBytes = projectedGlobalBytes

  remaining
    .filter { it.hostKey == targetHostKey }
    .sortedWith(oldestGenerationFirst)
    .forEach { candidate ->
      if (hostBytes > MOBILE_WEB_PER_HOST_CACHE_BYTE_LIMIT) {
        selected += candidate
        hostBytes -= candidate.byteLength
        globalBytes -= candidate.byteLength
        remaining.remove(candidate)
      }
    }
  if (hostBytes > MOBILE_WEB_PER_HOST_CACHE_BYTE_LIMIT) return null

  remaining
    .sortedWith(
      compareBy<MobileWebCacheGenerationCandidate> { if (it.hostKey == targetHostKey) 1 else 0 }
        .then(oldestGenerationFirst)
    )
    .forEach { candidate ->
      if (globalBytes > MOBILE_WEB_GLOBAL_CACHE_BYTE_LIMIT) {
        selected += candidate
        globalBytes -= candidate.byteLength
      }
    }
  if (globalBytes > MOBILE_WEB_GLOBAL_CACHE_BYTE_LIMIT) return null
  return selected
}

private val oldestGenerationFirst =
  compareBy<MobileWebCacheGenerationCandidate> { it.modifiedAtMillis }
    .thenBy { it.hostKey }
    .thenBy { it.buildId }
