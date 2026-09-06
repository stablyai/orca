import { describe, expect, it } from 'vitest'
import {
  describeHostedTerminalLinkPoint,
  hostedTerminalLinkPointsFromGeometry,
  readHostedTerminalLinkPoints
} from '../../scripts/hosted-terminal-link-locator.mjs'

const geometry = {
  cellHeight: 20,
  cellWidth: 10,
  cursorTop: 460,
  innerHeight: 740,
  screenRect: {
    height: 600,
    width: 400
  },
  terminalRect: {
    bottom: 700,
    height: 610,
    left: 0,
    top: 90,
    width: 400
  },
  screenHeight: 800,
  screenWidth: 400
}

describe('hosted terminal link locator', () => {
  it('maps fixed cursor-relative rows through the resized xterm grid', () => {
    expect(hostedTerminalLinkPointsFromGeometry(geometry)).toEqual({
      javascript: { x: 0.0875, y: 0.530625 },
      file: { x: 0.0875, y: 0.606875 },
      fileAlternate: { x: 0.0875, y: 0.6322916666666667 },
      http: { x: 0.0875, y: 0.683125 }
    })
  })

  it('uses rendered link rows when the cursor moved after staging', () => {
    expect(
      hostedTerminalLinkPointsFromGeometry({
        ...geometry,
        cursorTop: 20,
        linkRows: { javascript: 4, file: 7, fileAlternate: 8, http: 10 }
      })
    ).toEqual({
      javascript: { x: 0.0875, y: 0.301875 },
      file: { x: 0.0875, y: 0.378125 },
      fileAlternate: { x: 0.0875, y: 0.40354166666666663 },
      http: { x: 0.0875, y: 0.454375 }
    })
  })

  it('anchors the staged corpus to the viewport bottom when xterm is blurred', () => {
    expect(hostedTerminalLinkPointsFromGeometry({ ...geometry, cursorTop: 0 })).toEqual({
      javascript: { x: 0.0875, y: 0.683125 },
      file: { x: 0.0875, y: 0.759375 },
      fileAlternate: { x: 0.0875, y: 0.7847916666666666 },
      http: { x: 0.0875, y: 0.835625 }
    })
  })

  it('rejects an empty discovered xterm instead of tapping a guessed row', () => {
    expect(() =>
      hostedTerminalLinkPointsFromGeometry({
        ...geometry,
        cursorTop: 0,
        linkRows: { javascript: null, file: null, fileAlternate: null, http: null },
        xtermFound: true
      })
    ).toThrow('corpus is not present')
  })

  it('fails when the rendered cell geometry cannot describe the screen', () => {
    expect(() =>
      hostedTerminalLinkPointsFromGeometry({
        ...geometry,
        cellHeight: 70
      })
    ).toThrow('grid is invalid')
  })

  it('reports the DOM target under a normalized emulator point', async () => {
    const evaluate = async (_document: unknown, expression: string) => {
      expect(expression).toContain('"x":0.25')
      expect(expression).toContain('document.elementFromPoint')
      return JSON.stringify({ clientX: 100, clientY: 200, terminalHit: true })
    }

    await expect(
      describeHostedTerminalLinkPoint({}, { x: 0.25, y: 0.5 }, { evaluate })
    ).resolves.toEqual({
      clientX: 100,
      clientY: 200,
      terminalHit: true
    })
  })

  it('reads rendered link rows from the visible xterm buffer', async () => {
    const evaluate = async (_document: unknown, expression: string) => {
      expect(expression).toContain('xterm.buffer.active')
      return JSON.stringify({
        ...geometry,
        cursorTop: 0,
        linkRows: { javascript: 4, file: 7, fileAlternate: 8, http: 10 }
      })
    }

    await expect(readHostedTerminalLinkPoints({}, { evaluate })).resolves.toEqual(
      hostedTerminalLinkPointsFromGeometry({
        ...geometry,
        cursorTop: 0,
        linkRows: { javascript: 4, file: 7, fileAlternate: 8, http: 10 }
      })
    )
  })
})
