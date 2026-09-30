export const BUN_PERSISTENCE_RUNNERS = [
  'ubuntu-22.04',
  'ubuntu-24.04-arm',
  'macos-14',
  'macos-15-intel',
  'windows-2022',
  'windows-11-arm'
]

// Only surfaces whose behaviour actually differs per platform. Escalating on `config/`,
// `resources/` and `.github/` wholesale took 36.5% of the last 1100 commits through all six
// platforms where a platform-flavoured predicate takes 19%.
const PLATFORM_PREFIXES = [
  'native/',
  'config/patches/',
  '.github/actions/install-node-dependencies/',
  'src/main/persistence/',
  'src/main/sqlite/',
  'src/main/orcad/',
  'src/main/providers/',
  'src/main/daemon/',
  'src/main/ssh/',
  'src/main/wsl/',
  'src/relay/',
  'src/shared/child-process/'
]

export function bunProfileQualification(changedFiles, scope) {
  const platformSpecific = changedFiles.some(
    (file) =>
      // A root manifest can move a native dependency on every platform at once.
      !file.includes('/') ||
      PLATFORM_PREFIXES.some((prefix) => file.startsWith(prefix)) ||
      /(?:^|[/.-])(?:windows|win32|wsl|macos|darwin|linux|posix|bun)(?:[/.-]|$)/i.test(file)
  )
  // A pull request qualifies one platform unless the change is platform-flavoured; the push to
  // main re-qualifies all six, so an unescalated miss surfaces minutes after merge, not a day.
  const full = changedFiles.length === 0 || scope.graphUnavailable === true || platformSpecific
  return {
    qualification: full,
    runners: full ? BUN_PERSISTENCE_RUNNERS : ['ubuntu-22.04']
  }
}
