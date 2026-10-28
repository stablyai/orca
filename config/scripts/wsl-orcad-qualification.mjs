import { createHash } from 'node:crypto'
import { appendFileSync, readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

export const WSL_FAMILIES = ['ubuntu-24.04', 'debian-12', 'fedora-41']

const RUNTIME_PREFIXES = [
  'src/main/runtime/',
  'src/main/native-chat/',
  'src/main/claude/',
  'src/main/claude-accounts/',
  'src/main/codex/',
  'src/main/acp/',
  'src/main/pi/',
  'src/shared/'
]
const PLATFORM_INPUT =
  /(?:^|[/._-])(?:windows|win32|wsl|linux|darwin|macos|posix|native|platform|process|shell|spawn|filesystem|install|terminal|pty|environment|systemd|distro|prebuild|sqlite|daemon|host|remote|transport|bridge|socket|stdio|orcad)(?:[/._-]|$)/i

export function wslOrcadQualification(changed, modified, event = {}) {
  const full = (reason, candidate = WSL_FAMILIES) => ({
    families: WSL_FAMILIES,
    candidateFamilies: candidate,
    reason
  })
  if (
    event.name !== 'pull_request' ||
    !Number.isSafeInteger(event.number) ||
    event.number <= 0 ||
    !/^[a-f0-9]{40}$/.test(event.sourceSha ?? '') ||
    changed.length === 0 ||
    !Array.isArray(modified) ||
    new Set(changed).size !== changed.length ||
    new Set(modified).size !== modified.length ||
    modified.some((file) => !changed.includes(file))
  ) {
    return full('Full reference or incomplete change evidence')
  }
  let runtime = false
  for (const file of changed) {
    if (
      !/^[\w./-]+$/.test(file) ||
      file.startsWith('/') ||
      file.split('/').some((part) => part === '..' || part === '.')
    ) {
      return full('Unknown path')
    }
    if (file === 'src/main/wsl/wsl-orcad-real-distro-lane.test.ts') {
      return full(`Distro contract changed: ${file}`)
    }
    if (
      /\.test\.tsx?$/.test(file) ||
      file.startsWith('docs/') ||
      file.startsWith('mobile/') ||
      file.startsWith('src/renderer/') ||
      ['README.md', 'AGENTS.md', 'CLAUDE.md'].includes(file)
    ) {
      continue
    }
    if (
      !modified.includes(file) ||
      !file.endsWith('.ts') ||
      !RUNTIME_PREFIXES.some((prefix) => file.startsWith(prefix)) ||
      PLATFORM_INPUT.test(file)
    ) {
      return full(`Platform, build or unqualified input changed: ${file}`)
    }
    runtime = true
  }
  if (!runtime) {
    return full('No qualified runtime modification')
  }
  const candidate = ['ubuntu-24.04']
  // Keep 90% of eligible source revisions as full references during the canary.
  const bucket =
    createHash('sha256').update(`${event.number}:${event.sourceSha}`).digest().readUInt32BE(0) % 10
  return bucket === 0
    ? {
        families: candidate,
        candidateFamilies: candidate,
        reason: 'Runtime-only canary; Ubuntu keeps systemd off and on'
      }
    : full('Runtime-only full reference', candidate)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const changed = readFileSync(process.argv[2], 'utf8').split('\0').filter(Boolean)
  const modified = readFileSync(process.argv[3], 'utf8').split('\0').filter(Boolean)
  const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'))
  const result = wslOrcadQualification(changed, modified, {
    name: process.env.GITHUB_EVENT_NAME,
    number: event.pull_request?.number,
    sourceSha: event.pull_request?.head?.sha
  })
  appendFileSync(process.env.GITHUB_OUTPUT, `families=${JSON.stringify(result.families)}\n`)
  appendFileSync(
    process.env.GITHUB_STEP_SUMMARY,
    `WSL qualification: ${result.reason}. Executing ${result.families.join(', ')}; candidate ${result.candidateFamilies.join(', ')}.\n`
  )
}
