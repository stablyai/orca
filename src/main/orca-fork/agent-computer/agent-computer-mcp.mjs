#!/usr/bin/env node
// orca-fork: MCP server (stdio) that lets every agent on this machine see and drive the shared
// agent computer (agent-computer.sh) with screenshot/click/type/key/scroll/open-url tools.
import { execFile, spawn } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { promisify } from 'node:util'

const run = promisify(execFile)
const DISPLAY = process.env.DISPLAY || `:${process.env.ORCA_COMPUTER_DISPLAY || '42'}`
const ENV = { ...process.env, DISPLAY, LANG: process.env.LANG || 'C.UTF-8' }
const BUTTONS = { left: '1', middle: '2', right: '3' }
const SCROLL = { up: '4', down: '5', left: '6', right: '7' }

const point = {
  x: { type: 'integer', description: 'Screen x in pixels (screenshot coordinates)' },
  y: { type: 'integer', description: 'Screen y in pixels (screenshot coordinates)' }
}

const TOOLS = [
  {
    name: 'computer_screenshot',
    description:
      'Screenshot of the shared desktop (JPEG). Coordinates in it are the ones click/scroll take. The owner may be watching or controlling the same screen.',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'computer_click',
    description: 'Move the pointer to (x, y) and click.',
    inputSchema: {
      type: 'object',
      properties: {
        ...point,
        button: { type: 'string', enum: ['left', 'middle', 'right'], default: 'left' },
        double: { type: 'boolean', default: false }
      },
      required: ['x', 'y']
    }
  },
  {
    name: 'computer_drag',
    description: 'Press the left button at (x, y), move to (to_x, to_y) and release.',
    inputSchema: {
      type: 'object',
      properties: { ...point, to_x: { type: 'integer' }, to_y: { type: 'integer' } },
      required: ['x', 'y', 'to_x', 'to_y']
    }
  },
  {
    name: 'computer_type',
    description: 'Type text at the current keyboard focus.',
    inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] }
  },
  {
    name: 'computer_key',
    description:
      'Press keys or combos, xdotool names, space-separated: "Return", "ctrl+l", "ctrl+shift+t Escape".',
    inputSchema: { type: 'object', properties: { keys: { type: 'string' } }, required: ['keys'] }
  },
  {
    name: 'computer_scroll',
    description: 'Scroll at (x, y).',
    inputSchema: {
      type: 'object',
      properties: {
        ...point,
        direction: { type: 'string', enum: ['up', 'down', 'left', 'right'] },
        amount: { type: 'integer', default: 3, minimum: 1, maximum: 30 }
      },
      required: ['x', 'y', 'direction']
    }
  },
  {
    name: 'computer_open_url',
    description: 'Open a URL in the desktop browser (Chromium/Firefox) on the shared screen.',
    inputSchema: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] }
  },
  {
    name: 'computer_info',
    description: 'Screen size, pointer position and the active window title.',
    inputSchema: { type: 'object', properties: {} }
  }
]

async function xdotool(...args) {
  const { stdout } = await run('xdotool', args, { env: ENV, timeout: 15_000 })
  return stdout.trim()
}

async function screenshot() {
  const dir = await mkdtemp(join(tmpdir(), 'orca-computer-'))
  const file = join(dir, 'screen.jpg')
  try {
    await run('scrot', ['--overwrite', '--quality', '70', '--pointer', file], {
      env: ENV,
      timeout: 15_000
    })
    const data = (await readFile(file)).toString('base64')
    return [{ type: 'image', data, mimeType: 'image/jpeg' }]
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

async function openUrl(url) {
  if (!/^(https?|file):/i.test(url)) {
    throw new Error('Only http(s) and file URLs')
  }
  for (const browser of ['chromium', 'chromium-browser', 'google-chrome', 'firefox', 'xdg-open']) {
    try {
      await run('which', [browser])
    } catch {
      continue
    }
    spawn(browser, [url], { env: ENV, detached: true, stdio: 'ignore' }).unref()
    return `Opened in ${browser}`
  }
  throw new Error('No browser installed on this machine')
}

async function callTool(name, args) {
  switch (name) {
    case 'computer_screenshot':
      return screenshot()
    case 'computer_click': {
      const button = BUTTONS[args.button ?? 'left'] ?? '1'
      const repeat = args.double ? ['--repeat', '2'] : []
      await xdotool(
        'mousemove',
        '--sync',
        String(args.x),
        String(args.y),
        'click',
        ...repeat,
        button
      )
      return `Clicked ${args.button ?? 'left'} at ${args.x},${args.y}`
    }
    case 'computer_drag':
      await xdotool('mousemove', '--sync', String(args.x), String(args.y), 'mousedown', '1')
      await xdotool('mousemove', '--sync', String(args.to_x), String(args.to_y), 'mouseup', '1')
      return `Dragged ${args.x},${args.y} → ${args.to_x},${args.to_y}`
    case 'computer_type':
      await xdotool('type', '--delay', '12', '--', String(args.text))
      return `Typed ${String(args.text).length} characters`
    case 'computer_key':
      await xdotool('key', '--delay', '30', ...String(args.keys).split(/\s+/).filter(Boolean))
      return `Pressed ${args.keys}`
    case 'computer_scroll': {
      const amount = String(Math.min(30, Math.max(1, args.amount ?? 3)))
      const button = SCROLL[args.direction]
      if (!button) {
        throw new Error('direction must be up, down, left or right')
      }
      await xdotool('mousemove', '--sync', String(args.x), String(args.y))
      await xdotool('click', '--repeat', amount, button)
      return `Scrolled ${args.direction} ${amount} at ${args.x},${args.y}`
    }
    case 'computer_open_url':
      return openUrl(String(args.url))
    case 'computer_info': {
      const size = await xdotool('getdisplaygeometry')
      const pointer = await xdotool('getmouselocation')
      const title = await xdotool('getactivewindow', 'getwindowname').catch(() => '')
      return `DISPLAY=${DISPLAY} screen=${size.replace(' ', 'x')} ${pointer} active="${title}"`
    }
    default:
      throw new Error(`Unknown tool ${name}`)
  }
}

function send(message) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`)
}

async function handle(request) {
  const { id, method, params } = request
  if (method === 'initialize') {
    return {
      protocolVersion: params?.protocolVersion ?? '2025-06-18',
      capabilities: { tools: {} },
      serverInfo: { name: 'orca-agent-computer', version: '0.1.0' },
      instructions:
        'A real Linux desktop shared by every agent on this machine and watched (sometimes controlled) by the owner. Take a screenshot before acting and after each step to check the result.'
    }
  }
  if (method === 'tools/list') {
    return { tools: TOOLS }
  }
  if (method === 'tools/call') {
    try {
      const result = await callTool(params.name, params.arguments ?? {})
      const content = typeof result === 'string' ? [{ type: 'text', text: result }] : result
      return { content }
    } catch (error) {
      return { content: [{ type: 'text', text: String(error?.message ?? error) }], isError: true }
    }
  }
  if (method === 'ping') {
    return {}
  }
  if (id !== undefined) {
    throw Object.assign(new Error(`Method not found: ${method}`), { code: -32601 })
  }
  return undefined
}

createInterface({ input: process.stdin }).on('line', async (line) => {
  if (!line.trim()) {
    return
  }
  let request
  try {
    request = JSON.parse(line)
  } catch {
    send({ id: null, error: { code: -32700, message: 'Parse error' } })
    return
  }
  try {
    const result = await handle(request)
    if (request.id !== undefined && result !== undefined) {
      send({ id: request.id, result })
    }
  } catch (error) {
    send({ id: request.id, error: { code: error.code ?? -32603, message: String(error.message) } })
  }
})
