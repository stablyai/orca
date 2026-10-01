// Stable desktop release tags (vX.Y.Z); shared by the cross-version harness and the R1 protocol gate.
export const STABLE_DESKTOP_RELEASE_TAG = /^v\d+\.\d+\.\d+$/

export function compareReleaseTags(a, b) {
  const parts = (tag) =>
    tag
      .replace(/^v/, '')
      .split('.')
      .map((part) => Number.parseInt(part, 10))
      .map((value) => (Number.isFinite(value) ? value : 0))
  const left = parts(a)
  const right = parts(b)
  for (let index = 0; index < Math.max(left.length, right.length); index++) {
    const diff = (left[index] ?? 0) - (right[index] ?? 0)
    if (diff !== 0) {
      return diff
    }
  }
  return 0
}

/** @param {string[]} tags @returns {string | null} */
export function selectLatestStableReleaseTag(tags) {
  return (
    tags
      .filter((tag) => STABLE_DESKTOP_RELEASE_TAG.test(tag))
      .sort(compareReleaseTags)
      .at(-1) ?? null
  )
}
