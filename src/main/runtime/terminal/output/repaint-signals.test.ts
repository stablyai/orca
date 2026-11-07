import { describe, expect, it } from 'vitest'
import { scanRepaintSignals } from './repaint-signals'

describe('scanRepaintSignals', () => {
  it('finds a full-screen erase', () => {
    expect(scanRepaintSignals('hello\u001b[2Jworld')).toEqual({
      fullErase: true,
      bufferToggle: false,
      carry: ''
    })
  })

  it.each(['47', '1047', '1049'])('recognizes buffer mode %s among several parameters', (mode) => {
    expect(scanRepaintSignals(`\u001b[?25;${mode}h\u001b[2J`)).toEqual({
      fullErase: true,
      bufferToggle: true,
      carry: ''
    })
  })

  it('carries an incomplete sequence to the next chunk', () => {
    expect(scanRepaintSignals('\u001b[?25;4')).toEqual({
      fullErase: false,
      bufferToggle: false,
      carry: '\u001b[?25;4'
    })
    expect(scanRepaintSignals('\u001b[?25;4' + '7h\u001b[2J')).toMatchObject({
      fullErase: true,
      bufferToggle: true
    })
  })

  it('ignores an erase printed inside a control string', () => {
    expect(scanRepaintSignals('\u001b]0;title \u001b[2J text\u0007rest')).toEqual({
      fullErase: false,
      bufferToggle: false,
      carry: ''
    })
  })

  it('does not treat cursor save/restore as a buffer switch', () => {
    expect(scanRepaintSignals('\u001b[?1048h\u001b[2J')).toEqual({
      fullErase: true,
      bufferToggle: false,
      carry: ''
    })
  })
})
