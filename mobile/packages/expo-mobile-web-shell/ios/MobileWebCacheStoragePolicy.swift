import Foundation

let mobileWebPerHostCacheByteLimit: Int64 = 128 * 1024 * 1024
let mobileWebGlobalCacheByteLimit: Int64 = 512 * 1024 * 1024
let mobileWebMinimumFreeStorageBytes: Int64 = 16 * 1024 * 1024

struct MobileWebCacheGenerationCandidate {
  let hostKey: String
  let buildId: String
  let byteLength: Int64
  let modifiedAt: Date
  let root: URL
}

func mobileWebCacheEvictionPlan(
  candidates: [MobileWebCacheGenerationCandidate],
  targetHostKey: String,
  projectedHostBytes: Int64,
  projectedGlobalBytes: Int64
) -> [MobileWebCacheGenerationCandidate]? {
  var remaining = candidates
  var selected = [MobileWebCacheGenerationCandidate]()
  var hostBytes = projectedHostBytes
  var globalBytes = projectedGlobalBytes

  let hostCandidates = remaining
    .filter { $0.hostKey == targetHostKey }
    .sorted(by: oldestGenerationFirst)
  for candidate in hostCandidates where hostBytes > mobileWebPerHostCacheByteLimit {
    selected.append(candidate)
    hostBytes -= candidate.byteLength
    globalBytes -= candidate.byteLength
    remaining.removeAll { sameGeneration($0, candidate) }
  }
  guard hostBytes <= mobileWebPerHostCacheByteLimit else { return nil }

  let globalCandidates = remaining.sorted {
    let leftIsTarget = $0.hostKey == targetHostKey
    let rightIsTarget = $1.hostKey == targetHostKey
    if leftIsTarget != rightIsTarget { return !leftIsTarget }
    return oldestGenerationFirst($0, $1)
  }
  for candidate in globalCandidates where globalBytes > mobileWebGlobalCacheByteLimit {
    selected.append(candidate)
    globalBytes -= candidate.byteLength
  }
  guard globalBytes <= mobileWebGlobalCacheByteLimit else { return nil }
  return selected
}

private func oldestGenerationFirst(
  _ left: MobileWebCacheGenerationCandidate,
  _ right: MobileWebCacheGenerationCandidate
) -> Bool {
  if left.modifiedAt != right.modifiedAt { return left.modifiedAt < right.modifiedAt }
  if left.hostKey != right.hostKey { return left.hostKey < right.hostKey }
  return left.buildId < right.buildId
}

private func sameGeneration(
  _ left: MobileWebCacheGenerationCandidate,
  _ right: MobileWebCacheGenerationCandidate
) -> Bool {
  left.hostKey == right.hostKey && left.buildId == right.buildId
}
