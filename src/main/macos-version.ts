// Darwin kernel major -> macOS marketing major (Darwin 20 = macOS 11 ... 24 = macOS 15;
// Apple jumped to year-based versions afterwards, so Darwin 25 = macOS 26).
export function macOSMajorFromDarwinRelease(darwinRelease: string): number | null {
  const darwinMajor = Number.parseInt(darwinRelease.split('.')[0] ?? '', 10)
  if (!Number.isFinite(darwinMajor) || darwinMajor < 20) {
    return null
  }
  return darwinMajor >= 25 ? darwinMajor + 1 : darwinMajor - 9
}
