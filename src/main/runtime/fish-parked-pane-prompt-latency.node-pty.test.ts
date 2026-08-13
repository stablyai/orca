/**
 * Real-fish regression for the parked-pane DA1 stall.
 *
 * fish re-emits DA1 (`ESC [ 0 c`) at EVERY prompt paint and BLOCKS on the reply
 * for up to 10s. Its "give up after one timeout" latch only arms when the
 * timeout happens during the startup probe, so a reply source that disappears
 * later stalls every subsequent prompt, indefinitely.
 *
 * The configuration under test is a PARKED pane (xterm unmounted, so no
 * renderer responder exists) whose PTY still has a raw-byte sidecar registered
 * — a background agent launch, an automation observer, a draft-readiness
 * probe. Before the fix, that sidecar's delivery interest made main's query
 * authority yield ("the chunk was delivered, so a renderer xterm will answer
 * it") to a renderer that had no xterm at all, and nobody answered.
 *
 * Real production code under test, in production's two stages:
 *   1. the daemon Session's startup DA1 responder + query filter, released at
 *      shell-ready (session.ts) — WITHOUT it fish times out on its startup
 *      probe, latches "give up on DA1", and no later stall is observable;
 *   2. the main-side reply-ownership predicate (shouldModelAnswerHiddenPtyQueries)
 *      driving a runtime HeadlessEmulator wired as createPtyHeadlessTerminalState
 *      wires it.
 * Nothing here answers DA1 out of band — if stage 2's predicate says "not
 * mine", fish waits out its 10s cap.
 *
 * The assertion is PROMPT LATENCY, the observable symptom: a user's parked fish
 * pane taking 10s to redraw its prompt after every command.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { fishRequirementViolation, resolveFishBinary } from '../../shared/fish-binary-requirement'
import type { TerminalViewAttributes } from '../../shared/terminal-view-attributes'
import { HeadlessEmulator } from '../daemon/headless-emulator'
import {
  installDeviceAttributesResponder,
  StartupDeviceAttributesQueryFilter,
  STARTUP_DA1_RESPONSE
} from '../daemon/startup-device-attributes-responder'
import {
  _resetHiddenRendererPtyDeliveryGateForTest,
  markHiddenRendererPty,
  setRendererPtyDeliveryInterest
} from '../ipc/pty-hidden-delivery-gate'
import { shouldModelAnswerHiddenPtyQueries } from './terminal-model-query-authority'

const FISH = resolveFishBinary(4)
const itWithFish = FISH.available ? it : it.skip

const PTY_ID = 'fish-parked-pty'
const PROMPT_MARK = 'ORCA-DA1> '
// Well under fish's 10s DA1 cap, and far above the ~30ms an answered prompt takes.
const PROMPT_LATENCY_BUDGET_MS = 1_000
const PROMPT_WAIT_MS = 15_000
const SETTINGS = {
  terminalMainSideEffectAuthority: true,
  terminalHiddenDeliveryGate: true,
  terminalModelQueryAuthority: true
} as const

const VIEW_ATTRIBUTES: TerminalViewAttributes = {
  foreground: [238, 238, 238],
  background: [17, 17, 17],
  cursor: [238, 238, 238],
  ansi: Array.from({ length: 256 }, () => [128, 128, 128] as [number, number, number]),
  colorSchemeMode: 'dark',
  cursorStyle: 'block',
  cursorBlink: false
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

describe('a parked fish pane keeps painting prompts (DA1 must always have an answerer)', () => {
  let configHome: string | null = null
  let cleanup: (() => void) | null = null

  afterEach(() => {
    cleanup?.()
    cleanup = null
    _resetHiddenRendererPtyDeliveryGateForTest()
    if (configHome) {
      rmSync(configHome, { recursive: true, force: true })
      configHome = null
    }
  })

  // Always runs, so the CI lane cannot report green with the regression below skipped.
  it('has the fish this suite needs when CI requires one', () => {
    expect(fishRequirementViolation(FISH)).toBeNull()
  })

  itWithFish(
    'answers DA1 from the model while a sidecar holds delivery interest',
    async () => {
      const nodePty = await import('node-pty')

      configHome = mkdtempSync(path.join(tmpdir(), 'orca-fish-da1-'))
      mkdirSync(path.join(configHome, 'fish'), { recursive: true })
      // Why a bare prompt: fish core re-probes DA1 on every paint regardless of
      // what the prompt function prints, so nothing here shapes the measurement.
      writeFileSync(
        path.join(configHome, 'fish/config.fish'),
        [
          'set -g fish_greeting ""',
          `function fish_prompt; printf '${PROMPT_MARK}'; end`,
          'function fish_right_prompt; end',
          ''
        ].join('\n')
      )

      const term = nodePty.spawn(FISH.path as string, ['-l', '-i'], {
        name: 'xterm-256color',
        cols: 120,
        rows: 30,
        cwd: configHome,
        env: {
          PATH: process.env.PATH ?? '/usr/bin:/bin',
          HOME: configHome,
          TERM: 'xterm-256color',
          COLORTERM: 'truecolor',
          LANG: 'en_US.UTF-8',
          XDG_CONFIG_HOME: configHome,
          XDG_DATA_HOME: path.join(configHome, 'data')
        }
      })

      // Parked tab: the pane's xterm is unmounted (hidden mark) but a background
      // agent / automation sidecar still consumes raw bytes (delivery interest).
      markHiddenRendererPty(PTY_ID)
      setRendererPtyDeliveryInterest(PTY_ID, true)

      // Stage 1 — daemon Session: answers DA1 past the shell-ready input queue and
      // strips the query from downstream output, then hands DA1 back at ready.
      const daemonEmulator = new HeadlessEmulator({ cols: 120, rows: 30 })
      const startupFilter = new StartupDeviceAttributesQueryFilter()
      let releaseStartupResponder: (() => void) | null = installDeviceAttributesResponder({
        parser: daemonEmulator.responderParser,
        response: STARTUP_DA1_RESPONSE,
        reply: (data) => term.write(data)
      })

      // Stage 2 — main runtime model, the only post-startup answerer for a pane
      // with no xterm.
      const emulator = new HeadlessEmulator({
        cols: 120,
        rows: 30,
        onQueryReply: (reply) => term.write(reply)
      })
      emulator.installViewAttributeResponder(() => VIEW_ATTRIBUTES)
      emulator.applyPushedViewAttributes(VIEW_ATTRIBUTES)

      let promptCount = 0
      let writeChain: Promise<void> = Promise.resolve()
      term.onData((chunk) => {
        void daemonEmulator.write(chunk)
        const downstream = releaseStartupResponder ? startupFilter.accept(chunk) : chunk
        // Mirrors OrcaRuntimeService.onPtyData: ownership is captured per chunk at
        // ingestion and rides that chunk's write-chain link.
        const forwardQueryReplies = shouldModelAnswerHiddenPtyQueries({
          ptyId: PTY_ID,
          settings: SETTINGS,
          hasRemoteViewSubscriber: false
        })
        writeChain = writeChain.then(() => emulator.write(downstream, { forwardQueryReplies }))
        promptCount += chunk.split(PROMPT_MARK).length - 1
        if (promptCount > 0 && releaseStartupResponder) {
          // Shell-ready: the startup barrier is done, so DA1 goes back to whoever
          // owns the view. Production releases here too (session.ts).
          releaseStartupResponder()
          releaseStartupResponder = null
        }
      })

      cleanup = () => {
        try {
          term.kill()
        } catch {
          /* already gone */
        }
        releaseStartupResponder?.()
        emulator.dispose()
        daemonEmulator.dispose()
      }

      const waitForPromptCount = async (target: number): Promise<boolean> => {
        const deadline = Date.now() + PROMPT_WAIT_MS
        while (Date.now() < deadline) {
          if (promptCount >= target) {
            return true
          }
          await sleep(10)
        }
        return false
      }

      expect(await waitForPromptCount(1)).toBe(true)

      // Why three: the pre-fix failure is not the first prompt (the startup probe
      // has its own responder in production) but every prompt after it.
      const latenciesMs: number[] = []
      for (let round = 0; round < 3; round += 1) {
        const target = promptCount + 1
        const startedAt = Date.now()
        term.write('\r')
        const painted = await waitForPromptCount(target)
        latenciesMs.push(Date.now() - startedAt)
        expect(painted).toBe(true)
      }

      expect(Math.max(...latenciesMs)).toBeLessThan(PROMPT_LATENCY_BUDGET_MS)
    },
    120_000
  )
})
