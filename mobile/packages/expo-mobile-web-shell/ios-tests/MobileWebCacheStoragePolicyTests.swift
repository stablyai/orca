import Foundation

@main
enum MobileWebCacheStoragePolicyTests {
  static func main() {
    assert(
      mobileWebCacheEvictionPlan(
        candidates: [candidate(hostKey: "host-a", buildId: "1", bytes: 10, modified: 1)],
        targetHostKey: "host-a",
        projectedHostBytes: mobileWebPerHostCacheByteLimit,
        projectedGlobalBytes: mobileWebGlobalCacheByteLimit
      )?.isEmpty == true
    )

    let oldest = candidate(hostKey: "host-a", buildId: "1", bytes: 10, modified: 1)
    let newer = candidate(hostKey: "host-a", buildId: "2", bytes: 10, modified: 2)
    assert(
      mobileWebCacheEvictionPlan(
        candidates: [newer, oldest],
        targetHostKey: "host-a",
        projectedHostBytes: mobileWebPerHostCacheByteLimit + 10,
        projectedGlobalBytes: mobileWebGlobalCacheByteLimit
      )?.map(\.buildId) == ["1"]
    )

    let target = candidate(hostKey: "host-a", buildId: "1", bytes: 10, modified: 1)
    let other = candidate(hostKey: "host-b", buildId: "2", bytes: 10, modified: 2)
    assert(
      mobileWebCacheEvictionPlan(
        candidates: [target, other],
        targetHostKey: "host-a",
        projectedHostBytes: mobileWebPerHostCacheByteLimit,
        projectedGlobalBytes: mobileWebGlobalCacheByteLimit + 10
      )?.map(\.hostKey) == ["host-b"]
    )

    assert(
      mobileWebCacheEvictionPlan(
        candidates: [],
        targetHostKey: "host-a",
        projectedHostBytes: mobileWebPerHostCacheByteLimit + 1,
        projectedGlobalBytes: mobileWebGlobalCacheByteLimit
      ) == nil
    )
  }

  private static func candidate(
    hostKey: String,
    buildId: String,
    bytes: Int64,
    modified: TimeInterval
  ) -> MobileWebCacheGenerationCandidate {
    MobileWebCacheGenerationCandidate(
      hostKey: hostKey,
      buildId: buildId,
      byteLength: bytes,
      modifiedAt: Date(timeIntervalSince1970: modified),
      root: URL(fileURLWithPath: "/\(hostKey)/\(buildId)")
    )
  }
}
