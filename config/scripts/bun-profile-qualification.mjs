export const BUN_PERSISTENCE_RUNNERS = [
  'ubuntu-22.04',
  'ubuntu-24.04-arm',
  'macos-14',
  'macos-15-intel',
  'windows-2022',
  'windows-11-arm'
]

const QUALIFICATION_PREFIXES = [
  'config/',
  'native/',
  'resources/',
  '.github/',
  'src/main/persistence/',
  'src/main/sqlite/',
  'src/main/orcad/',
  'src/main/providers/',
  'src/main/daemon/',
  'src/main/ssh/',
  'src/relay/',
  'src/shared/child-process/'
]

export function bunProfileQualification(changedFiles, scope, event = {}) {
  const sensitive = changedFiles.some(
    (file) =>
      !file.includes('/') ||
      QUALIFICATION_PREFIXES.some((prefix) => file.startsWith(prefix)) ||
      /(?:^|[/.-])(?:windows|win32|wsl|macos|darwin|linux|posix|bun)(?:[/.-]|$)/i.test(file)
  )
  // Only a proven unrelated platform change in a draft may defer qualification.
  const full =
    event.pull_request?.draft !== true ||
    changedFiles.length === 0 ||
    scope.graphUnavailable === true ||
    sensitive
  return {
    qualification: full,
    runners: full ? BUN_PERSISTENCE_RUNNERS : ['ubuntu-22.04']
  }
}
