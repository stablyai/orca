import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { RUNTIME_CAPABILITIES } from '../../../shared/protocol-version'
import { SSH_TARGET_MANAGEMENT_RUNTIME_CAPABILITY } from '../../../shared/ssh-target-management'
import { SKILL_INSTALL_CAPABILITY } from '../../../shared/skill-install-capability'

/**
 * Electron (`main-process-*`) and orcad (`orcad-entry.ts`) each compose the same runtime, and every
 * dependency is optional, so one root can silently skip a service the other wires (#30120 never
 * gave orcad its web client root). This records what each root's source wires and fails on any
 * difference that is not declared below with a reason.
 */

type Root = 'electron' | 'orcad'

type DeclaredDifference = {
  wiring: string
  missingOn: Root
  reason: string
  /** Capabilities the missing host still advertises; its methods must refuse accurately. */
  advertisedUnserved?: readonly string[]
}

const DECLARED_HOST_DIFFERENCES: readonly DeclaredDifference[] = [
  {
    wiring: 'runtime.setArtifactService',
    missingOn: 'orcad',
    reason: 'Artifact sharing uses the desktop sign-in; a headless host has none yet.'
  },
  {
    wiring: 'runtime.setSkillCloudService',
    missingOn: 'orcad',
    reason: 'Skill sharing uses the desktop sign-in; installs from Git still work on orcad.',
    advertisedUnserved: [SKILL_INSTALL_CAPABILITY]
  },
  {
    wiring: 'registerSshHandlers',
    missingOn: 'orcad',
    reason: 'orcad has no SSH stack; its SSH target methods refuse with an accurate message.',
    advertisedUnserved: [SSH_TARGET_MANAGEMENT_RUNTIME_CAPABILITY]
  },
  {
    wiring: 'runtime.setAgentBrowserBridge',
    missingOn: 'orcad',
    reason: 'orcad installs browser automation through the runtime factory when Chromium exists.'
  },
  {
    wiring: 'runtime.setEmulatorBridge',
    missingOn: 'orcad',
    reason: 'Device emulators are desktop-only.'
  },
  {
    wiring: 'runtime.setOffscreenBrowserBackend',
    missingOn: 'orcad',
    reason: 'Offscreen WebContents need Electron.'
  },
  {
    wiring: 'ctor:prepareClaudeAuth',
    missingOn: 'orcad',
    reason: 'orcad passes it to registerHeadlessPtyRuntime instead, and only off WSL.'
  },
  {
    wiring: 'ctor:onPtyStopped',
    missingOn: 'orcad',
    reason: 'It clears renderer-side provider state, and orcad has no renderer.'
  },
  {
    wiring: 'ctor:onTerminalSideEffects',
    missingOn: 'orcad',
    reason: 'Side effects are delivered to a desktop window only.'
  },
  {
    wiring: 'ctor:attestAgentHookCompatibilityAuthority',
    missingOn: 'orcad',
    reason: 'Compatibility hook authority belongs to desktop-launched panes.'
  },
  {
    wiring: 'ctor:retireAgentHookCompatibilityAuthority',
    missingOn: 'orcad',
    reason: 'Pairs with attestAgentHookCompatibilityAuthority.'
  },
  {
    wiring: 'ctor:getPairedDeviceName',
    missingOn: 'orcad',
    reason: 'Unwired gap (follow-up): client-hosted browser rows show no paired-device name.'
  },
  {
    wiring: 'ctor:orchestrationEnvironmentTransport',
    missingOn: 'orcad',
    reason: 'Cross-environment orchestration dials paired environments from the desktop only.'
  },
  {
    wiring: 'ctor:skillTransactionRecovery',
    missingOn: 'orcad',
    reason:
      'No startup skill-transaction recovery runs on orcad, so installs need not wait for one.'
  },
  {
    wiring: 'rpc-option:exposeNetworkByDefault',
    missingOn: 'orcad',
    reason: 'orcad pins its bind host instead, so exposure never widens itself.'
  },
  {
    wiring: 'rpc.setMobileDesktopRelayHosts',
    missingOn: 'orcad',
    reason: 'The mobile desktop relay is hosted by the desktop.'
  },
  {
    wiring: 'rpc.setOnUnpairedDeviceAuthFailure',
    missingOn: 'orcad',
    reason: 'It notifies a desktop window.'
  },
  {
    wiring: 'rpc-option:pinnedBindHost',
    missingOn: 'electron',
    reason: 'The desktop binds loopback until a device pairs (STA-2370).'
  }
]

const ROOT_SOURCES: Record<Root, readonly string[]> = {
  electron: [
    'src/main/startup/main-process-runtime-service.ts',
    'src/main/startup/main-process-ready-runtime.ts',
    'src/main/startup/main-process-runtime-launch.ts',
    'src/main/window/attach-main-window-services.ts'
  ],
  orcad: ['src/main/orcad/orcad-entry.ts', 'src/main/orcad/orcad-account-services.ts']
}

/** A spread with no inline object literal names the source of the object it spreads. */
const SPREAD_SOURCES: Record<string, { file: string; anchor: string }> = {
  'agentHookRuntimeDeps(': {
    file: 'src/main/agent-hooks/agent-hook-runtime-deps.ts',
    anchor: 'return {'
  },
  codexStructuredLaunchHomeResolvers: {
    file: 'src/main/startup/codex-launch-preparation.ts',
    anchor: 'codexStructuredLaunchHomeResolvers = {'
  },
  'accountLaunch?.runtimeDeps': {
    file: 'src/main/orcad/orcad-account-services.ts',
    anchor: 'runtimeDeps: {'
  },
  'orcadWsPortOptions(': { file: 'src/main/orcad/orcad-ws-port-policy.ts', anchor: 'wsPort: port' }
}

const repoRoot = join(__dirname, '../../../..')
const read = (file: string): string => stripComments(readFileSync(join(repoRoot, file), 'utf8'))

const QUOTES = `'"\``

/** The index of the quote that closes the string opening at `open` (or the end of the source). */
function stringEnd(source: string, open: number): number {
  for (let i = open + 1; i < source.length; i++) {
    if (source[i] === '\\') {
      i++
    } else if (source[i] === source[open]) {
      return i
    }
  }
  return source.length
}

function stripComments(source: string): string {
  let out = ''
  for (let i = 0; i < source.length; i++) {
    const char = source[i]
    if (QUOTES.includes(char)) {
      const end = stringEnd(source, i)
      out += source.slice(i, end + 1)
      i = end
    } else if (char === '/' && source[i + 1] === '/') {
      while (i < source.length && source[i] !== '\n') {
        i++
      }
      out += '\n'
    } else if (char === '/' && source[i + 1] === '*') {
      const end = source.indexOf('*/', i + 2)
      i = end === -1 ? source.length : end + 1
    } else {
      out += char
    }
  }
  return out
}

/** The inner text of the brace group that opens at `open` (strings are opaque). */
function braceGroup(source: string, open: number): string {
  let depth = 0
  for (let i = open; i < source.length; i++) {
    const char = source[i]
    if (QUOTES.includes(char)) {
      i = stringEnd(source, i)
    } else if (char === '{') {
      depth++
    } else if (char === '}' && --depth === 0) {
      return source.slice(open + 1, i)
    }
  }
  throw new Error('unbalanced braces')
}

/** The last match: a type declaring the same shape comes before the value. */
function objectLiteralAfter(source: string, anchor: string): string {
  const at = source.lastIndexOf(anchor)
  if (at === -1) {
    throw new Error(`anchor not found: ${anchor}`)
  }
  const anchorOpen = anchor.lastIndexOf('{')
  // An anchor inside the literal (no brace of its own) belongs to the nearest enclosing `{`.
  const open = anchorOpen !== -1 ? at + anchorOpen : source.lastIndexOf('{', at)
  return braceGroup(source, open)
}

/** Top-level entries of an object literal's inner text, split on depth-0 commas. */
function topLevelEntries(inner: string): string[] {
  const entries: string[] = []
  let depth = 0
  let start = 0
  for (let i = 0; i < inner.length; i++) {
    const char = inner[i]
    if (QUOTES.includes(char)) {
      i = stringEnd(inner, i)
    } else if ('({['.includes(char)) {
      depth++
    } else if (')}]'.includes(char)) {
      depth--
    } else if (char === ',' && depth === 0) {
      entries.push(inner.slice(start, i).trim())
      start = i + 1
    }
  }
  entries.push(inner.slice(start).trim())
  return entries.filter(Boolean)
}

function objectKeys(inner: string): string[] {
  const keys: string[] = []
  for (const entry of topLevelEntries(inner)) {
    if (!entry.startsWith('...')) {
      const key = /^(?:async\s+)?([A-Za-z_$][\w$]*)/.exec(entry)?.[1]
      if (!key) {
        throw new Error(`unparsed object entry: ${entry}`)
      }
      keys.push(key)
      continue
    }
    const spread = entry.slice(3).trim()
    const source = Object.entries(SPREAD_SOURCES).find(([prefix]) => spread.startsWith(prefix))
    if (source) {
      keys.push(...objectKeys(objectLiteralAfter(read(source[1].file), source[1].anchor)))
      continue
    }
    // An inline conditional spread, e.g. `...(cond ? { a } : {})`: every literal it may spread.
    let found = false
    for (let i = spread.indexOf('{'); i !== -1; i = spread.indexOf('{', i + 1)) {
      const group = braceGroup(spread, i)
      keys.push(...objectKeys(group))
      i += group.length + 1
      found = true
    }
    if (!found) {
      throw new Error(`teach SPREAD_SOURCES where this spread comes from: ${spread}`)
    }
  }
  return keys
}

function recordWiring(root: Root): Set<string> {
  const wired = new Set<string>()
  for (const file of ROOT_SOURCES[root]) {
    const source = read(file)
    if (source.includes('new OrcaRuntimeService(')) {
      const args = source.slice(source.indexOf('new OrcaRuntimeService('))
      for (const key of objectKeys(braceGroup(args, args.indexOf('{')))) {
        wired.add(`ctor:${key}`)
      }
    }
    if (source.includes('new OrcaRuntimeRpcServer(')) {
      for (const key of objectKeys(objectLiteralAfter(source, 'new OrcaRuntimeRpcServer({'))) {
        wired.add(`rpc-option:${key}`)
      }
    }
    for (const [, receiver, setter] of source.matchAll(
      /\b(runtime|runtimeRpc|rpc)\.(set[A-Z]\w*)\(/g
    )) {
      wired.add(`${receiver === 'runtime' ? 'runtime' : 'rpc'}.${setter}`)
    }
    if (/\bregister(?:HeadlessServe)?SshHandlers\(/.test(source)) {
      wired.add('registerSshHandlers')
    }
  }
  return wired
}

describe('runtime composition parity (Electron vs orcad)', () => {
  const electron = recordWiring('electron')
  const orcad = recordWiring('orcad')

  it('records the wiring both roots share', () => {
    for (const shared of [
      'ctor:getLocalProvider',
      'ctor:onTerminalAgentStatus',
      'ctor:agentSessionClaimSigner',
      'rpc-option:webClientRoot',
      'rpc-option:wsPort',
      'runtime.setAccountServices'
    ]) {
      expect(electron, shared).toContain(shared)
      expect(orcad, shared).toContain(shared)
    }
  })

  it('declares every wiring one root skips, and nothing it does not skip', () => {
    const actual = [
      ...[...electron].filter((w) => !orcad.has(w)).map((w) => `orcad lacks ${w}`),
      ...[...orcad].filter((w) => !electron.has(w)).map((w) => `electron lacks ${w}`)
    ].sort()
    const declared = DECLARED_HOST_DIFFERENCES.map((d) => `${d.missingOn} lacks ${d.wiring}`)
    expect(actual).toEqual([...declared].sort())
  })

  it('lists each advertised-but-unserved capability against what the host advertises', () => {
    for (const difference of DECLARED_HOST_DIFFERENCES) {
      expect(difference.reason, difference.wiring).not.toBe('')
      for (const capability of difference.advertisedUnserved ?? []) {
        // Not advertised any more: drop it from the declaration.
        expect(new Set<string>(RUNTIME_CAPABILITIES), difference.wiring).toContain(capability)
      }
    }
  })
})
