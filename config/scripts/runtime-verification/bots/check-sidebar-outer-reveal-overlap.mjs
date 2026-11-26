import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { chromium } from 'playwright-core'
import { ensureFixtureServer } from '../../component-fixtures/fixture-server-client.mjs'

const outIndex = process.argv.indexOf('--out')
const out = path.resolve(
  outIndex === -1 ? '.cache/sidebar-reveal-overlap' : process.argv[outIndex + 1]
)
await mkdir(out, { recursive: true })
const sourceFile =
  'src/renderer/src/components/sidebar/worktree-list/navigation/worktree-sidebar-reveal.ts'
const source = await readFile(sourceFile)
const { url } = await ensureFixtureServer()
const browser = await chromium.launch({ headless: true })
const results = []
try {
  for (const theme of ['light', 'dark']) {
    for (const reduced of [false, true]) {
      for (const consumer of ['worktree', 'row', 'compact']) {
        const name = `${consumer}-${reduced ? 'reduced' : 'motion'}-${theme}`
        const page = await browser.newPage({
          viewport: { width: 1280, height: 900 },
          deviceScaleFactor: 2
        })
        page.setDefaultTimeout(15_000)
        await page.emulateMedia({ reducedMotion: reduced ? 'reduce' : 'no-preference' })
        try {
          await page.goto(
            `${url}/fixtures.html?id=bots/BotSidebarSearch:longListBeforeProjectReveal&theme=${theme}`
          )
          await page.waitForFunction(
            () => document.documentElement.dataset.fixtureState === 'ready'
          )
          await page.evaluate(async () => {
            const { useAppStore } = await import('/src/store/index.ts')
            const state = useAppStore.getState()
            const first = Object.values(state.worktreesByRepo).flat()[0]
            useAppStore.setState({
              worktreesByRepo: {
                [first.repoId]: Array.from({ length: 16 }, (_, index) => ({
                  ...first,
                  id: `overlap-${index}`,
                  displayName: `Overlap ${index}`,
                  path: `/proof/overlap-${index}`,
                  sortOrder: index,
                  lastActivityAt: 16 - index
                }))
              },
              sortBy: 'manual',
              activeWorktreeId: null,
              activeWorkspaceKey: null,
              activeWorkspaceExecutionHostId: null
            })
            document.querySelector('input[type=search]').blur()
            document.querySelector('[data-sidebar-window]').style.height = '241px'
            const slot = document.querySelector('[data-sidebar-projects-list]')
            Object.assign(slot.style, { minHeight: '240px', height: '240px', flex: 'none' })
          })
          await page.waitForFunction(
            () => document.querySelector('[data-worktree-sidebar]')?.clientHeight === 240
          )
          await page.evaluate(() => {
            const inner = document.querySelector('[data-worktree-sidebar]')
            const outer = inner.closest('[data-sidebar-content-viewport]')
            inner.scrollTo({ top: 0, behavior: 'instant' })
            outer.scrollTo({
              top:
                outer.scrollTop +
                inner.getBoundingClientRect().top -
                outer.getBoundingClientRect().top,
              behavior: 'instant'
            })
          })
          await page.evaluate(
            () =>
              new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
          )
          await page.evaluate(async (consumer) => {
            const { useAppStore } = await import('/src/store/index.ts')
            const { revealCompactAgentCard } =
              await import('/src/components/sidebar/worktree-list/navigation/worktree-sidebar-reveal.ts')
            const inner = document.querySelector('[data-worktree-sidebar]')
            const outer = inner.closest('[data-sidebar-content-viewport]')
            const visibility = (row) => {
              const box = row.getBoundingClientRect(),
                i = inner.getBoundingClientRect(),
                o = outer.getBoundingClientRect()
              const sticky = [...inner.querySelectorAll('[data-worktree-sticky-header-active]')]
                .map((h) => h.getBoundingClientRect())
                .filter(
                  (h) =>
                    h.top < box.bottom && h.bottom > box.top && h.top < o.bottom && h.bottom > o.top
                )
              const top = Math.max(i.top, o.top, ...sticky.map((h) => h.bottom)),
                bottom = Math.min(i.bottom, o.bottom)
              return {
                full: box.top >= top - 0.5 && box.bottom <= bottom + 0.5,
                box: box.toJSON(),
                top,
                bottom
              }
            }
            const rows = () => [...inner.querySelectorAll('[data-worktree-id]')]
            const a = rows().find(
              (row) => row.getBoundingClientRect().top > inner.getBoundingClientRect().bottom + 10
            )
            if (!a) {
              throw new Error('No mounted offscreen A target')
            }
            const trace = (window.__overlap = {
              a: a.dataset.worktreeId,
              calls: [],
              cleared: [],
              started: false,
              quiet: 0,
              frames: 0,
              visibility
            })
            const original = outer.scrollTo.bind(outer)
            outer.scrollTo = (options) => {
              trace.calls.push({ options, at: outer.scrollTop })
              original(options)
              if (trace.started) {
                return
              }
              trace.started = true
              queueMicrotask(() => {
                const b = rows().find(
                  (row) => row.dataset.worktreeId !== trace.a && visibility(row).full
                )
                if (!b) {
                  trace.error = 'No distinct currently-visible B target'
                  return
                }
                trace.b = b.dataset.worktreeId
                trace.bAtRequest = visibility(b)
                if (consumer === 'worktree') {
                  useAppStore.getState().revealWorktreeInSidebar(trace.b, {
                    behavior: 'smooth',
                    executionHostId: 'local'
                  })
                } else if (consumer === 'row') {
                  useAppStore
                    .getState()
                    .revealSidebarRow(b.dataset.worktreeRowKey, { behavior: 'smooth' })
                } else {
                  revealCompactAgentCard(b.querySelector('[data-worktree-card-surface]'))
                  trace.bCleared = true
                  trace.bAtClear = visibility(b)
                }
              })
            }
            useAppStore.subscribe((state, previous) => {
              for (const key of ['pendingRevealWorktree', 'pendingRevealSidebarRow']) {
                if (previous[key] && state[key] === null) {
                  trace.cleared.push({ key, target: previous[key] })
                  if (
                    (key === 'pendingRevealWorktree' && previous[key].worktreeId === trace.b) ||
                    (key === 'pendingRevealSidebarRow' &&
                      previous[key].rowKey ===
                        rows().find((row) => row.dataset.worktreeId === trace.b)?.dataset
                          .worktreeRowKey)
                  ) {
                    trace.bCleared = true
                    trace.bAtClear = visibility(
                      rows().find((row) => row.dataset.worktreeId === trace.b)
                    )
                  }
                }
              }
            })
            useAppStore
              .getState()
              .revealWorktreeInSidebar(trace.a, { behavior: 'smooth', executionHostId: 'local' })
          }, consumer)
          await page.waitForFunction(() => window.__overlap.error || window.__overlap.bCleared)
          await page.waitForFunction(() => {
            const trace = window.__overlap
            const inner = document.querySelector('[data-worktree-sidebar]'),
              outer = inner.closest('[data-sidebar-content-viewport]')
            const offsets = `${inner.scrollTop},${outer.scrollTop}`
            trace.quiet = trace.offsets === offsets ? trace.quiet + 1 : 0
            trace.offsets = offsets
            trace.frames++
            return trace.frames >= 20 && trace.quiet >= 6
          })
          const actual = await page.evaluate(() => {
            const t = window.__overlap
            const row = document.querySelector(`[data-worktree-id="${t.b}"]`)
            return {
              a: t.a,
              b: t.b,
              error: t.error,
              bAtRequest: t.bAtRequest,
              bAtClear: t.bAtClear,
              final: row && t.visibility(row),
              calls: t.calls,
              cleared: t.cleared,
              bCleared: t.bCleared
            }
          })
          await page
            .locator('#component-fixture-frame')
            .screenshot({ path: path.join(out, `${name}.png`) })
          assert.equal(actual.error, undefined)
          assert.ok(actual.calls[0].options.top > actual.calls[0].at, 'A starts outer movement')
          assert.ok(
            actual.cleared.some(
              (entry) =>
                entry.key === 'pendingRevealWorktree' && entry.target.worktreeId === actual.a
            ),
            'the A pending request clears'
          )
          assert.ok(actual.bAtRequest.full, 'B is fully visible when it supersedes A')
          assert.ok(
            actual.bCleared,
            'the B pending request clears (shared consumer has no pending request)'
          )
          assert.ok(actual.bAtClear.full, 'B is still fully visible when its request clears')
          assert.ok(
            actual.final.full,
            'settled B useful bounds clear both scroll owners and sticky headers'
          )
          results.push({ name, passed: true, actual })
        } catch (error) {
          const state = await page
            .evaluate(() => {
              const t = window.__overlap
              const row = t?.b && document.querySelector(`[data-worktree-id="${t.b}"]`)
              return (
                t && {
                  a: t.a,
                  b: t.b,
                  error: t.error,
                  bAtRequest: t.bAtRequest,
                  bAtClear: t.bAtClear,
                  final: row && t.visibility(row),
                  calls: t.calls,
                  cleared: t.cleared,
                  bCleared: t.bCleared
                }
              )
            })
            .catch(() => null)
          await page.screenshot({ path: path.join(out, `${name}-failure.png`) }).catch(() => {})
          results.push({ name, passed: false, message: error.message, actual: state })
        } finally {
          await page.close()
        }
      }
    }
  }
} finally {
  await browser.close()
}
await writeFile(
  path.join(out, 'geometry.json'),
  JSON.stringify(
    {
      head: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
      sourceFile,
      sourceSha1: createHash('sha1').update(source).digest('hex'),
      sourceMatchesC3: source.equals(execFileSync('git', ['show', `0e64cfabc8cf:${sourceFile}`])),
      results
    },
    null,
    2
  )
)
const failures = results.filter((result) => !result.passed)
console.log(
  `${failures.length ? 'FAIL' : 'PASS'}: ${results.length - failures.length}/${results.length} outer reveal overlap cases`
)
for (const failure of failures) {
  console.error(`${failure.name}: ${failure.message}`)
}
process.exitCode = failures.length ? 1 : 0
