// Why: the agent catalog projection is budgeted at 512 KiB and only rides
// settings.get as the legacy piggyback for hosts without settings.agentCatalog.get.
// A caller that reads settings without opting out drags that payload onto
// every unrelated read, so the opt-out is asserted rather than left to review.
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const MOBILE_ROOT = join(__dirname, '..', '..')
// The only caller allowed to piggyback: it falls back to settings.get against
// hosts that predate settings.agentCatalog.get.
const CATALOG_PIGGYBACK_OWNER = join(MOBILE_ROOT, 'src', 'transport', 'agent-catalog-sync.ts')

function listSourceFiles(root: string): string[] {
  const files: string[] = []
  for (const entry of readdirSync(root)) {
    const path = join(root, entry)
    if (statSync(path).isDirectory()) {
      files.push(...listSourceFiles(path))
      continue
    }
    if (/\.[cm]?[jt]sx?$/.test(entry) && !/\.test\.[cm]?[jt]sx?$/.test(entry)) {
      files.push(path)
    }
  }
  return files
}

function scannedSources(): { path: string; source: string }[] {
  return [join(MOBILE_ROOT, 'app'), join(MOBILE_ROOT, 'src')]
    .flatMap((root) => listSourceFiles(root))
    .filter((path) => path !== CATALOG_PIGGYBACK_OWNER)
    .map((path) => ({
      path,
      // Drop line comments so an explanatory comment between the method name and
      // its params can't push the opt-out outside the match window.
      source: readFileSync(path, 'utf8').replace(/^\s*\/\/.*$/gm, '')
    }))
}

function describeSite(path: string, match: string): string {
  return `${path.slice(MOBILE_ROOT.length + 1)}: ${match.split('\n')[0]}`
}

function callSitesNotOptingOut(): string[] {
  const sites: string[] = []
  for (const { path, source } of scannedSources()) {
    for (const match of source.matchAll(/['"]settings\.get['"](.{0,80})/gs)) {
      if (!match[1]!.includes('includeAgentCatalog')) {
        sites.push(describeSite(path, match[0]!))
      }
    }
  }
  return sites
}

// sendSingleFlightRequest coalesces by (client, host, requestKind) and lets the
// latest queued params win, so two settings.get callers disagreeing about
// includeAgentCatalog could hand one of them the other's response. Keeping every
// single-flight settings.get caller opted out makes that mismatch unreachable.
function singleFlightSettingsSitesNotOptingOut(): string[] {
  const sites: string[] = []
  for (const { path, source } of scannedSources()) {
    for (const match of source.matchAll(
      /sendSingleFlightRequest\([^)]*?['"]settings\.get['"](.{0,80})/gs
    )) {
      if (!match[1]!.includes('includeAgentCatalog: false')) {
        sites.push(describeSite(path, match[0]!))
      }
    }
  }
  return sites
}

describe('mobile settings.get catalog opt-out', () => {
  it('opts every mobile settings.get caller out of the piggybacked agent catalog', () => {
    expect(callSitesNotOptingOut()).toEqual([])
  })

  it('keeps every single-flight settings.get caller on the same opted-out params', () => {
    expect(singleFlightSettingsSitesNotOptingOut()).toEqual([])
  })

  it('keeps the catalog piggyback off the params-blind single-flight path', () => {
    expect(readFileSync(CATALOG_PIGGYBACK_OWNER, 'utf8')).not.toContain('sendSingleFlightRequest')
  })
})
