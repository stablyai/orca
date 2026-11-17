const assert = require('node:assert/strict')
const fs = require('node:fs')
const { execFileSync } = require('node:child_process')
const { tmpdir } = require('node:os')
const { join } = require('node:path')

const pty = require(process.argv[2])
const mode = process.argv[3]
const root = fs.mkdtempSync(join(tmpdir(), 'orca-pty-input-'))
let terminal
let unblock
let finished = false
let output = ''
const deadline = setTimeout(() => finish(new Error('PTY input did not complete')), 5000)

function finish(error) {
  if (finished) {
    return
  }
  finished = true
  clearTimeout(deadline)
  unblock?.()
  terminal?.destroy()
  fs.rmSync(root, { recursive: true, force: true })
  if (error) {
    console.error(error.message)
    process.exitCode = 1
  } else {
    console.log('input delivered')
  }
}

function start(command, onReady, onOutput) {
  terminal = pty.spawn('/bin/sh', ['-c', command], {
    cwd: root,
    env: { PATH: '/usr/bin:/bin', TERM: 'xterm' },
    cols: 80,
    rows: 24
  })
  let ready = false
  terminal.onData((data) => {
    output += data
    try {
      if (!ready && output.includes('READY')) {
        ready = true
        onReady()
      }
      onOutput(output)
    } catch (error) {
      finish(error)
    }
  })
}

if (mode === 'threadpool') {
  assert.equal(process.env.UV_THREADPOOL_SIZE, '1')
  const fifo = join(root, 'blocked-open')
  execFileSync('mkfifo', [fifo])
  let canaryCompleted = false
  start(
    'stty -echo; printf "READY\\n"; IFS= read -r line; printf "RECEIVED:%s\\n" "$line"',
    () => {
      let writer
      unblock = () => {
        writer = fs.openSync(fifo, fs.constants.O_RDWR | fs.constants.O_NONBLOCK)
      }
      fs.open(fifo, 'r', (error, fd) => {
        if (!error) {
          fs.closeSync(fd)
        }
        if (writer !== undefined) {
          fs.closeSync(writer)
        }
      })
      fs.stat(__filename, () => {
        canaryCompleted = true
      })
      terminal.write('hello\n')
    },
    (data) => {
      if (!data.includes('RECEIVED:hello')) {
        return
      }
      assert.equal(canaryCompleted, false, 'the worker must remain blocked during delivery')
      finish()
    }
  )
} else if (mode === 'backpressure') {
  start(
    'stty raw -echo; printf "READY\\n"; exec sleep 10',
    () => {
      terminal.write(Buffer.alloc(1024 * 1024, 120))
      // A blocking master would never return from write(), preventing this timer.
      setTimeout(() => finish(), 25)
    },
    () => {}
  )
} else if (mode === 'paste') {
  start(
    'stty raw -echo; printf "READY\\n"; head -c 1048576 | cksum',
    () => {
      const chunk = Buffer.from('0123456789中文'.repeat(4096))
      for (let i = 0; i < 16; i++) {
        terminal.write(chunk)
      }
      chunk.fill(0)
    },
    (data) => {
      if (data.includes('4247255096 1048576')) {
        finish()
      }
    }
  )
} else {
  finish(new Error(`Unknown scenario: ${mode}`))
}
