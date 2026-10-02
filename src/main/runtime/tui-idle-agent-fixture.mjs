// Real agent-TUI stand-in for tui-idle-name-only-real-pty.integration.test.ts.
// Emits a genuine name-only OSC title while streaming, then settles per mode.
const mode = process.argv[2]
const workMs = Number(process.argv[3] ?? 6000)
const osc = (title) => `]0;${title}`

process.stdout.write(osc(mode === 'omp-stale' ? 'π : project' : 'Codex'))
if (mode === 'omp-stale') {
  setTimeout(() => process.stdout.write('working before pause\n'), 100)
}
const end = Date.now() + workMs
const streaming = setInterval(() => {
  if (Date.now() >= end) {
    clearInterval(streaming)
    if (mode === 'explicit-idle') {
      process.stdout.write(osc('Codex ready'))
    }
    if (mode === 'omp-stale') {
      process.stdout.write(osc('π > project'))
    }
    return
  }
  if (mode === 'omp-stale' && Date.now() < end - workMs + 3_500) {
    return
  }
  process.stdout.write(`analysing chunk ${Date.now()}\n`)
}, 250)

// Stay alive so the PTY foreground process remains this agent, never the shell.
setInterval(() => {}, 1 << 30)
