export const NODE_SERVER_RUNNERS = [
  'ubuntu-22.04',
  'ubuntu-24.04-arm',
  'macos-15',
  'macos-15-intel',
  'windows-2022',
  'windows-11-arm'
]

// Shared execution and storage changes need every host; explicit platform paths need their family.
const BUILD_PREFIXES = [
  'native/',
  'config/patches/',
  '.github/actions/install-node-dependencies/',
  '.github/actions/restore-pnpm-verification/',
  '.github/actions/prepare-native-runtime/',
  '.github/actions/prepare-orcad-prebuilds/'
]
// A remote target's OS does not identify the client platform that builds its commands.
const CROSS_HOST_PREFIXES = ['src/main/ssh/', 'src/main/providers/', 'src/relay/']
const PLATFORM_PREFIXES = [
  'src/main/persistence/',
  'src/main/sqlite/',
  'src/main/orcad/',
  'src/main/daemon/',
  'src/main/wsl/',
  'src/shared/child-process/'
]

const PLATFORM_FAMILIES = [
  { pattern: /(?:^|[/.-])(?:windows|win32|wsl)(?:[/.-]|$)/i, prefix: 'windows-' },
  { pattern: /(?:^|[/.-])(?:macos|darwin|posix)(?:[/.-]|$)/i, prefix: 'macos-' },
  { pattern: /(?:^|[/.-])(?:linux|posix)(?:[/.-]|$)/i, prefix: 'ubuntu-' }
]

export function nodeServerQualification(changedFiles, scope, { fullQualification = false } = {}) {
  const selected = new Set(['ubuntu-22.04'])
  let qualification = false
  let full = fullQualification || changedFiles.length === 0 || scope.graphUnavailable === true
  for (const file of changedFiles) {
    // Build policy and native sources can change every slot, even with a platform in the name.
    if (
      !file.includes('/') ||
      BUILD_PREFIXES.some((prefix) => file.startsWith(prefix)) ||
      CROSS_HOST_PREFIXES.some((prefix) => file.startsWith(prefix)) ||
      (/(?:^|[/.-])(?:remote|ssh)(?:[/.-]|$)/i.test(file) &&
        PLATFORM_FAMILIES.some(({ pattern }) => pattern.test(file))) ||
      file === 'src/shared/node-runtime-pin.ts' ||
      file === '.github/workflows/node-server-tests.yml' ||
      file.startsWith('config/scripts/node-server-') ||
      /(?:^|[/.-])(?:bun|prebuilds?)(?:[/.-]|$)/i.test(file)
    ) {
      full = true
      continue
    }
    const families = PLATFORM_FAMILIES.filter(({ pattern }) => pattern.test(file))
    if (families.length > 0) {
      for (const { prefix } of families) {
        for (const runner of NODE_SERVER_RUNNERS.filter((runner) => runner.startsWith(prefix))) {
          selected.add(runner)
        }
        qualification ||= prefix === 'ubuntu-'
      }
    } else if (PLATFORM_PREFIXES.some((prefix) => file.startsWith(prefix))) {
      full = true
    }
  }
  return {
    qualification: full || qualification,
    runners: full
      ? NODE_SERVER_RUNNERS
      : NODE_SERVER_RUNNERS.filter((runner) => selected.has(runner))
  }
}
