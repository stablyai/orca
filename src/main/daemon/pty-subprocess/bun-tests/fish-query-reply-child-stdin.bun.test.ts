/**
 * Real-fish regression for #13892: a terminal query reply Orca held back is overtaken
 * by the DA1 answer written later in the same turn, so fish's read sentinel hands the
 * tty to the child while the OSC 11 reply is still queued — and the CHILD READS IT.
 *
 * What is real here: bundled Bun running fish, `PtyStartupIngress`, `PtyStartupReplyDelivery`
 * and both echo probes, plus the host's own write gate
 * (`answerLiveQueryReply` models the historical write gate that deferred replies). Only the renderer is modelled: it
 * answers queries strictly in the order they appear in the stream, so any inversion the
 * child sees was produced by the delivery split and nothing else.
 *
 * The assertion is about a CHILD PROCESS'S STDIN, not the screen: a rendered-output check
 * passes while the bytes are still being eaten by the next `npx` / `brew` confirm prompt.
 * The child reads a full LINE because a leaked reply carries no newline, so a
 * once('data') child would report it alone whenever it happened to land in its own read.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { fishRequirementViolation, resolveFishBinary } from '../../../../shared/fish-binary-requirement'
import { runBundledBunFixture } from '../../../bundled-bun-test-execution'

// Why fish 4: the DA1-sentinel handoff this measures lives in the 4.0 Rust tty_handoff.
const FISH = resolveFishBinary(4)
const itWithFish = FISH.available ? it : it.skip

const PROMPT_MARK = 'ORCA13892> '

describe('a held query reply never reaches the next child process (#13892)', () => {
  let configHome: string | null = null

  // Always runs, so the CI lane cannot report green with the regression below skipped.
  it('has the fish this suite needs when CI requires one', () => {
    expect(fishRequirementViolation(FISH)).toBeNull()
  })

  afterEach(() => {
    if (configHome) {
      rmSync(configHome, { recursive: true, force: true })
      configHome = null
    }
  })

  itWithFish(
    'answers OSC 11 in the query turn so the reply cannot land in the child’s stdin',
    async () => {
      configHome = mkdtempSync(path.join(tmpdir(), 'orca-fish-13892-'))
      mkdirSync(path.join(configHome, 'fish'), { recursive: true })
      writeFileSync(
        path.join(configHome, 'fish/config.fish'),
        [
          'set -g fish_greeting ""',
          `function fish_prompt; printf '${PROMPT_MARK}'; end`,
          'function fish_right_prompt; end',
          ''
        ].join('\n')
      )
      const childScript = path.join(configHome, 'read-stdin.mjs')
      writeFileSync(
        childScript,
        "let buffered = ''\n" +
          "process.stdin.on('data', (d) => {\n" +
          "  buffered += d.toString('utf8')\n" +
          "  if (!buffered.includes('\\n')) return\n" +
          "  process.stdout.write('CHILD-READ:' + JSON.stringify(buffered) + '\\n')\n" +
          '  process.exit(0)\n' +
          '})\n'
      )

      if (!FISH.path) {
        throw new Error('Fish binary missing')
      }
      await runBundledBunFixture(
        path.join(__dirname, 'fish-query-reply-child-stdin-bun-fixture.ts'),
        'runFishQueryReplyFixture',
        { binary: FISH.path, configHome, childScript, nodeBinary: process.execPath },
        40_000
      )
    },
    45_000
  )
})
