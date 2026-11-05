// Real-PTY stand-in streams under a name-only OSC title, then settles according to mode.
const mode = process.argv[2]
const workMs = Number(process.argv[3] ?? 6000)
const osc = (title) => `]0;${title}`

process.stdout.write(osc('Codex'))
const end = Date.now() + workMs
const streaming = setInterval(() => {
  if (Date.now() >= end) {
    clearInterval(streaming)
    if (mode === 'explicit-idle') {
      process.stdout.write(osc('Codex ready'))
    }
    return
  }
  process.stdout.write(`analysing chunk ${Date.now()}\n`)
}, 250)

// Stay alive so the PTY foreground process remains this agent, never the shell.
setInterval(() => {}, 1 << 30)
