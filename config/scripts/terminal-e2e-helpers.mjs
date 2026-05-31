#!/usr/bin/env node
/**
 * Terminal E2E helpers for agent-browser + CDP testing against a running Orca
 * dev build. Encapsulates patterns discovered during manual terminal testing:
 *
 *   - CDP key events do NOT work with xterm.js (canvas-based renderer)
 *   - ClipboardEvent paste simulation does NOT work
 *   - Direct PTY write via `window.api.pty.write(id, data)` DOES work
 *   - PTY IDs are sequential integers starting from 1
 *   - The visible terminal's PTY ID must be discovered (not guessed)
 *
 * Usage:
 *   import { OrcaTerminal } from './terminal-e2e-helpers.mjs'
 *
 *   const term = new OrcaTerminal(9444)       // CDP port
 *   await term.connect()
 *   const ptyId = await term.discoverActivePtyId()
 *   await term.send(ptyId, 'echo hello\r')
 *   const screenshot = await term.screenshot()
 *   await term.waitForOutput(ptyId, 'hello')
 *
 * Or run directly:
 *   node config/scripts/terminal-e2e-helpers.mjs --port 9444 --command 'echo hello'
 */

import { execFileSync } from 'child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const AGENT_BROWSER = 'agent-browser'
const sleepBuffer = new Int32Array(new SharedArrayBuffer(4))

function sleep(ms) {
  Atomics.wait(sleepBuffer, 0, 0, ms)
}

function tempScreenshotPath(filename) {
  return join(tmpdir(), filename)
}

/** Thin wrapper around `agent-browser --cdp <port> <subcommand>`. */
function ab(port, args) {
  const result = execFileSync(AGENT_BROWSER, ['--cdp', String(port), ...args], {
    encoding: 'utf-8',
    timeout: 15_000
  })
  return result.trim()
}

/** Run JS in the renderer via `agent-browser eval`. */
function evalInRenderer(port, js) {
  return ab(port, ['eval', js])
}

export class OrcaTerminal {
  /** @param {number} cdpPort — the --remote-debugging-port used when launching Orca */
  constructor(cdpPort) {
    this.port = cdpPort
  }

  /** Verify connection by taking a snapshot. */
  connect() {
    ab(this.port, ['snapshot', '-i'])
  }

  /**
   * Discover the PTY ID of the currently visible terminal pane.
   *
   * Why: PTY IDs are opaque sequential integers and the mapping from
   * visible tab → PTY ID isn't exposed in the DOM. We send a unique
   * marker to candidate IDs and see which one appears in the active pane.
   *
   * @param {number} maxId — highest PTY ID to probe (default 10)
   * @returns {string} the PTY ID string
   */
  discoverActivePtyId(maxId = 10) {
    const marker = `__PTY_PROBE_${Date.now()}__`

    // Send Ctrl+C + marker echo to each candidate PTY
    const js = `
      (function() {
        for (let i = 1; i <= ${maxId}; i++) {
          window.api.pty.write(String(i), '\\x03\\x15echo ' + '${marker}_' + i + '\\r');
        }
        return 'probed 1-${maxId}';
      })()
    `
    evalInRenderer(this.port, js)

    // Wait for output to render
    sleep(1_500)

    // Read the visible xterm buffer to find which marker appeared
    const bufferJs = `
      (function() {
        const xterms = document.querySelectorAll('.xterm');
        const visible = Array.from(xterms).find(x => x.offsetParent !== null);
        if (!visible) return JSON.stringify({error: 'no visible xterm'});
        // Read the screen buffer's text via the DOM text layer or serialize addon
        // xterm renders to canvas, so read from the buffer API
        // We check if the serialize addon exposed the buffer text
        const screen = visible.querySelector('.xterm-screen');
        // Fallback: read textContent from the accessibility tree
        const accessibilityEl = visible.querySelector('.xterm-accessibility');
        const text = accessibilityEl?.textContent || '';
        return JSON.stringify({text: text.slice(-2000)});
      })()
    `
    const bufferResult = evalInRenderer(this.port, bufferJs)

    // Parse the marker from the buffer
    let parsed
    try {
      parsed = JSON.parse(bufferResult.replace(/^"|"$/g, '').replace(/\\"/g, '"'))
    } catch {
      throw new Error(`discoverActivePtyId: failed to parse buffer result: ${bufferResult}`)
    }
    if (parsed.error) {
      throw new Error(`discoverActivePtyId: ${parsed.error}`)
    }

    // Find all markers, take the last one (most recent = the visible terminal)
    const markerRe = new RegExp(`${marker}_(\\d+)`, 'g')
    const matches = [...parsed.text.matchAll(markerRe)]
    if (matches.length === 0) {
      // Fallback: take screenshot and try OCR-free approach by probing write
      throw new Error(
        'discoverActivePtyId: no marker found in buffer. ' +
          'The accessibility tree may be disabled. ' +
          'Try using probePtyIdWithScreenshot() instead.'
      )
    }
    return matches.at(-1)[1]
  }

  /**
   * Alternative PTY discovery: send markers, take a screenshot, and let the
   * caller visually identify which PTY responded.
   *
   * @param {number} maxId — highest PTY ID to probe
   * @param {string} screenshotPath — where to save the screenshot
   */
  probePtyIdWithScreenshot(maxId = 10, screenshotPath = tempScreenshotPath('orca-pty-probe.png')) {
    for (let i = 1; i <= maxId; i++) {
      evalInRenderer(this.port, `window.api.pty.write('${i}', '\\x03\\x15echo PTY_ID_${i}\\r')`)
    }
    sleep(2_000)
    this.screenshot(screenshotPath)
    return screenshotPath
  }

  /**
   * Send text to a specific PTY.
   *
   * @param {string} ptyId — the PTY ID (from discoverActivePtyId)
   * @param {string} text — text to send (use \r for Enter, \x03 for Ctrl+C, etc.)
   */
  send(ptyId, text) {
    // Escape for JS string literal inside eval
    const escaped = text.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\r/g, '\\r')
    evalInRenderer(this.port, `window.api.pty.write('${ptyId}', '${escaped}')`)
  }

  /**
   * Send a shell command and press Enter.
   *
   * @param {string} ptyId
   * @param {string} command — the shell command (Enter is appended)
   */
  exec(ptyId, command) {
    this.send(ptyId, `${command}\r`)
  }

  /** Send Ctrl+C to a PTY. */
  interrupt(ptyId) {
    this.send(ptyId, '\x03')
  }

  /** Clear the current line (Ctrl+U). */
  clearLine(ptyId) {
    this.send(ptyId, '\x15')
  }

  /**
   * Take a screenshot of the Orca window.
   *
   * @param {string} path — output file path
   * @returns {string} the screenshot path
   */
  screenshot(path = tempScreenshotPath('orca-terminal.png')) {
    ab(this.port, ['screenshot', path])
    return path
  }

  /**
   * Open a new terminal tab in Orca.
   * @returns {void}
   */
  newTerminal() {
    ab(this.port, ['click', '@e7']) // "New terminal (Cmd+T)" button
    sleep(2_000)
  }

  /**
   * Read the LANG value from a PTY's shell environment.
   *
   * @param {string} ptyId
   * @returns {string} the LANG value
   */
  readLang(ptyId) {
    this.exec(ptyId, 'echo __LANG__=$LANG')
    sleep(1_000)
    // Screenshot and return for inspection
    return this.screenshot(tempScreenshotPath('orca-lang-check.png'))
  }
}

// ---------------------------------------------------------------------------
// CLI entrypoint
// ---------------------------------------------------------------------------
if (process.argv[1]?.endsWith('terminal-e2e-helpers.mjs')) {
  const args = process.argv.slice(2)
  const portIdx = args.indexOf('--port')
  const cmdIdx = args.indexOf('--command')
  const port = portIdx >= 0 ? Number(args[portIdx + 1]) : 9444
  const command = cmdIdx >= 0 ? args[cmdIdx + 1] : null

  const term = new OrcaTerminal(port)
  console.log('Connecting to Orca on CDP port', port, '...')
  term.connect()
  console.log('Connected.')

  if (args.includes('--discover')) {
    const screenshotPath = term.probePtyIdWithScreenshot()
    console.log('Sent PTY probes. Check screenshot:', screenshotPath)
  }

  if (command) {
    const ptyId = args[args.indexOf('--pty') + 1]
    if (!ptyId) {
      console.error('--command requires --pty <id>. Use --discover first to find PTY IDs.')
      process.exit(1)
    }
    term.exec(ptyId, command)
    const shot = term.screenshot()
    console.log('Executed. Screenshot:', shot)
  }
}
