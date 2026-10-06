/**
 * Whether a repo source path is test-only by this repo's naming conventions: specs, test helpers
 * and doubles that sit beside their spec (`*-test-harness.ts`, `*-fixtures.ts`, `*-fake.ts`), and
 * test directories (`__tests__/`, `orca-runtime-tests/`). Shared by the Electron-import check and
 * the localization audit, so a helper is test-only to both or to neither.
 */

// Why `(?<!self)`: `*-self-test-*` modules are a shipped runtime probe, not tests.
const TEST_ONLY_BASENAME =
  /\.(?:test|spec)\.|(?<!self)[.-]test-|[.-](?:fixtures?|mocks?|fakes?|stubs?|doubles?)\.[cm]?[jt]sx?$/
const TEST_ONLY_DIRECTORY = /^(?:__)?(?:tests?|fixtures?|mocks)(?:__)?$|(?:^|[.-])tests?(?:[.-]|$)/

/** @param {string} relativePath Repo-relative path with `/` separators. */
export function isTestOnlySourcePath(relativePath) {
  const directories = relativePath.split('/')
  const basename = directories.pop() ?? ''
  return TEST_ONLY_BASENAME.test(basename) || directories.some(isTestOnlyDirectoryName)
}

/** Lets a directory walk prune a whole test tree instead of testing every file in it. */
export function isTestOnlyDirectoryName(name) {
  return TEST_ONLY_DIRECTORY.test(name)
}
