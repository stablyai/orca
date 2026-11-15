import { describe, expect, it } from 'vitest'
import { MANIFEST } from '../vm-scripts.generated'
import { entryPointMismatches, installerCommands, parseDockerDiff, pinnedTools, unexpectedChanges, versionMismatches } from './boot-twice-checks'

const HOME = '/home/ubuntu'

describe('unexpectedChanges', () => {
  it('allows boot state, per-boot config and the parent directories they live in', () => {
    const diff = parseDockerDiff(
      [
        'C /home',
        'C /home/ubuntu',
        'C /home/ubuntu/.orca-sandbox',
        'A /home/ubuntu/.orca-sandbox/opencode-first-run',
        'C /home/ubuntu/.orcad-data/agent-hooks/endpoint.env',
        'C /home/ubuntu/.codex/config.toml',
        'C /opt',
        'C /opt/orca',
        'C /opt/orca/compile-cache/v24-x64/712488c2',
        'A /tmp/x',
        'C /run'
      ].join('\n')
    )
    expect(unexpectedChanges(diff, HOME)).toEqual([])
  })

  it('flags installs: image files, package caches and node_modules anywhere', () => {
    const diff = parseDockerDiff(
      [
        'C /opt/orca/bin/orca-sandbox-start',
        'A /opt/orca/tools/lib/node_modules/x/package.json',
        'A /home/ubuntu/.npm/_cacache/index',
        'A /home/ubuntu/.config/opencode/node_modules/@opencode-ai/plugin',
        'A /home/ubuntu/.orcad-data/node_modules/x',
        'C /usr/lib/x',
        'C /etc/apt/sources.list.d/ubuntu.sources',
        'C /home/ubuntu/.config/opencode'
      ].join('\n')
    )
    expect(unexpectedChanges(diff, HOME).map((entry) => entry.path)).toEqual([
      '/opt/orca/bin/orca-sandbox-start',
      '/opt/orca/tools/lib/node_modules/x/package.json',
      '/home/ubuntu/.npm/_cacache/index',
      '/home/ubuntu/.config/opencode/node_modules/@opencode-ai/plugin',
      '/home/ubuntu/.orcad-data/node_modules/x',
      '/usr/lib/x',
      '/etc/apt/sources.list.d/ubuntu.sources'
    ])
  })

  it('does not take an added directory above an allowed path as a parent change', () => {
    expect(unexpectedChanges([{ kind: 'A', path: '/opt/orca' }], HOME)).toHaveLength(1)
  })
})

describe('pinned versions', () => {
  const tools = pinnedTools(MANIFEST)

  it('covers every agent CLI package and the pinned binaries', () => {
    expect(tools.filter((tool) => tool.source === 'package')).toHaveLength(MANIFEST.agentCliPackages.length)
    expect(tools.map((tool) => tool.name)).toEqual(expect.arrayContaining(['@anthropic-ai/claude-code', 'gh', 'google-chrome']))
  })

  it('matches exact package versions and version lines that contain the pin', () => {
    const observed: Record<string, string | null> = {}
    for (const tool of tools) {
      observed[tool.name] = tool.source === 'package' ? tool.expect : `prefix ${tool.expect} (suffix)`
    }
    expect(versionMismatches(tools, observed)).toEqual([])
    const claude = tools.find((tool) => tool.name === '@anthropic-ai/claude-code')!
    expect(versionMismatches([claude], { [claude.name]: '0.0.1' })).toEqual([`${claude.name}: "0.0.1" does not match the pin ${claude.expect}`])
    expect(versionMismatches([claude], {})).toEqual([`${claude.name}: missing (pinned ${claude.expect})`])
  })

  it("reads Chrome's .deb revision off the version it reports", () => {
    const chrome = tools.find((tool) => tool.name === 'google-chrome')!
    expect(chrome.expect).not.toMatch(/-\d+$/)
  })
})

describe('entryPointMismatches', () => {
  it('names missing and changed entry points', () => {
    expect(entryPointMismatches({ a: '1', b: '2', c: '3' }, { a: '1', b: '9' })).toEqual([
      'b: differs from image/vm/b',
      'c: missing from /opt/orca/bin'
    ])
  })
})

describe('installerCommands', () => {
  it('finds installs, fetches and first-run work among sampled command lines', () => {
    expect(
      installerCommands([
        'bash -c timeout 120 "$1" models && : >"$2" opencode-first-run /opt/orca/tools/bin/opencode /home/ubuntu/.orca-sandbox/opencode-first-run',
        'timeout 120 /opt/orca/tools/bin/opencode models ',
        '/opt/orca/runtime/runtimes/node-x/bin/node /opt/orca/bin/orcad-boot --code-cache x',
        'curl -fsS --max-time 25 -o /tmp/b.tgz https://example.invalid/b.tgz',
        'git -C /vercel/sandbox/project fetch --progress origin',
        'git fetch origin',
        'sleep 0.05',
        'tr \\0  ',
        ''
      ])
    ).toEqual([
      'timeout 120 /opt/orca/tools/bin/opencode models',
      'curl -fsS --max-time 25 -o /tmp/b.tgz https://example.invalid/b.tgz',
      'git -C /vercel/sandbox/project fetch --progress origin',
      'git fetch origin'
    ])
  })
})
