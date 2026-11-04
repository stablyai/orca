import { describe, expect, it } from 'vitest'
import { toBrowserConsoleResult, toBrowserNetworkLogResult } from './agent-browser-log-entries'

// Trimmed from real agent-browser 0.27.3 and 0.41.0 `--json` data; both print the same fields.
const consoleOutput = {
  messages: [
    { args: [{ type: 'string', value: 'hello log' }], text: 'hello log', type: 'log' },
    { args: [{ type: 'string', value: 'a warning' }], text: 'a warning', type: 'warning' },
    { args: [{ type: 'string', value: 'an error' }], text: 'an error', type: 'error' }
  ]
}

const networkOutput = {
  requests: [
    {
      headers: { 'Accept-Language': 'en-US,en;q=0.9' },
      method: 'GET',
      mimeType: 'text/html',
      requestId: 'BECA21D6BA0B635E9916700B48479394',
      resourceType: 'Document',
      responseHeaders: { 'Content-Length': '254' },
      status: 200,
      timestamp: 1793283228914,
      url: 'http://127.0.0.1:47811/page.html'
    },
    {
      headers: { 'Accept-Language': 'en-US,en;q=0.9' },
      method: 'GET',
      requestId: '45376.2',
      resourceType: 'Fetch',
      timestamp: 1793283228914,
      url: 'https://example.com/?a=1'
    }
  ]
}

describe('toBrowserConsoleResult', () => {
  it('maps messages to entries and keeps the newest up to the limit', () => {
    expect(toBrowserConsoleResult(consoleOutput, undefined)).toEqual({
      entries: [
        { level: 'log', text: 'hello log' },
        { level: 'warning', text: 'a warning' },
        { level: 'error', text: 'an error' }
      ],
      truncated: false
    })
    expect(toBrowserConsoleResult(consoleOutput, 2)).toEqual({
      entries: [
        { level: 'warning', text: 'a warning' },
        { level: 'error', text: 'an error' }
      ],
      truncated: true
    })
  })
})

describe('toBrowserNetworkLogResult', () => {
  it('maps requests to entries, including ones without a response, up to the limit', () => {
    expect(toBrowserNetworkLogResult(networkOutput, undefined)).toEqual({
      entries: [
        {
          url: 'http://127.0.0.1:47811/page.html',
          method: 'GET',
          status: 200,
          mimeType: 'text/html',
          timestamp: 1793283228914
        },
        { url: 'https://example.com/?a=1', method: 'GET', timestamp: 1793283228914 }
      ],
      truncated: false
    })
    expect(toBrowserNetworkLogResult(networkOutput, 1).entries).toEqual([
      { url: 'https://example.com/?a=1', method: 'GET', timestamp: 1793283228914 }
    ])
  })
})
