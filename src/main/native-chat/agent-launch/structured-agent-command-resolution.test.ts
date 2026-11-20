import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { resolveStructuredAgentCommand } from './structured-agent-command-resolution'
import { rememberManagedAgentRelease } from '../../managed-agent-cli/managed-agent-cli-registry'
import { explainConfiguredCommandExit } from '../../claude/structured/startup/claude-command-start-failure'
import { claudeStartupError } from '../../claude/structured/startup/claude-structured-session-startup-exit'
import { claudeStartupResultError } from '../../claude/sdk-transport/claude-stream-json-exit-error'
import {
  providerStartupFailureFact,
  withObservedProviderExit
} from '../agent-session-wire/startup/structured-agent-session-failure-text'
import {
  providerDiagnostic,
  providerDiagnosticOf,
  withProviderDiagnostic
} from '../../../shared/agent-session/failures/agent-session-failure'

describe.skipIf(process.platform === 'win32')("a Claude start under the user's Command", () => {
  let bin: string

  const script = (name: string): string => {
    const path = join(bin, name)
    writeFileSync(path, '#!/bin/sh\nexit 1\n')
    chmodSync(path, 0o755)
    return path
  }
  const resolve = (command: string) =>
    resolveStructuredAgentCommand(
      'claude',
      { agentCmdOverrides: { claude: command } },
      { pathEnv: bin, platform: process.platform }
    )
  const exited = (stderr: string) =>
    withObservedProviderExit(
      withProviderDiagnostic(
        new Error('claude stream-json exited'),
        providerDiagnostic(`(code 1)\n${stderr}`, 'log')
      )
    )
  const startFact = async (command: string, stderr: string) => {
    const { command: program, configured } = resolve(command)
    return providerStartupFailureFact(
      await explainConfiguredCommandExit(exited(stderr), {
        pathToClaudeCodeExecutable: program,
        ...(configured ? { configuredCommand: configured } : {})
      })
    )
  }

  beforeEach(() => {
    bin = mkdtempSync(join(tmpdir(), 'orca-agent-command-'))
  })

  afterEach(() => {
    rmSync(bin, { recursive: true, force: true })
  })

  const refusalOf = (command: string): unknown => {
    try {
      resolve(command)
    } catch (error) {
      return error
    }
    throw new Error(`${command} resolved`)
  }

  it('names a missing program, and leaves shell syntax to the sentence that says how to fix it', () => {
    const missing = refusalOf('missing --verbose')
    expect(missing).toMatchObject({ reason: 'agentCommandNotRunnable' })
    expect(providerDiagnosticOf(missing)).toEqual({
      text: "'missing' isn't a program Orca can find",
      audience: 'person'
    })
    const variable = refusalOf('ANTHROPIC_MODEL=x claude')
    expect(variable).toMatchObject({ reason: 'agentCommandNotRunnable' })
    expect(providerDiagnosticOf(variable)).toBeUndefined()
  })

  it('names the program a bare Command ran and what it said when it exited', async () => {
    const cc = script('cc')
    expect(await startFact('cc', "cc: error: unknown argument: '--output-format'")).toMatchObject({
      kind: 'agentCommandNotRunnable',
      detail: {
        text: `'cc' ran ${cc} and exited: cc: error: unknown argument: '--output-format'`,
        audience: 'person'
      }
    })
  })

  it("keeps Claude's own answer before an exit under a custom Command", async () => {
    const wrapper = script('wrapper')
    const connection = {
      startupFailure: () =>
        claudeStartupResultError({
          errors: ['No conversation found with session ID: 123e4567-e89b-12d3-a456-426614174000']
        }),
      initializationResult: () => Promise.resolve()
    }
    const launch = { pathToClaudeCodeExecutable: wrapper, configuredCommand: wrapper }
    const failure = await claudeStartupError(exited(''), { connection, launch, published: false })
    expect(providerStartupFailureFact(failure).kind).toBe('savedConversationMissing')
  })

  it('names an absolute-path Command, with its exit status when it said nothing', async () => {
    const wrapper = script('wrapper')
    expect(await startFact(wrapper, '')).toMatchObject({
      kind: 'agentCommandNotRunnable',
      detail: { text: `'${wrapper}' ran ${wrapper} and exited (code 1)`, audience: 'person' }
    })
  })
})

describe('Orca’s agy', () => {
  const release = join('/orca-data', 'agent-runtimes', 'agy', '1.5.13')
  const agy = join(release, process.platform === 'win32' ? 'agy.exe' : 'agy')

  afterEach(() => rememberManagedAgentRelease('antigravity', null))

  it.each([
    ['agy', agy],
    ['agy_acp_server.par', 'agy_acp_server.par']
  ])('stands in only for a missing `agy`: %s resolves to %s', (command, expected) => {
    rememberManagedAgentRelease('antigravity', release)

    const resolved = resolveStructuredAgentCommand(
      'antigravity',
      {},
      { pathEnv: '' },
      { command, resolve: (name) => name }
    )

    expect(resolved).toEqual({ command: expected, prefixArgs: [] })
  })
})
