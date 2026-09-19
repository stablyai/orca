import { Script } from 'node:vm'
import { expect, it } from 'vitest'
import { XTERM_ENGINE_JS } from './terminal-webview-engine.generated'

it('retires overwritten hyperlinks in the bundled WebView engine while preserving the live link', async () => {
  const result: unknown = await new Script(`
    var window = globalThis;
    var self = globalThis;
    ${XTERM_ENGINE_JS}
    (async function () {
      var term = new Terminal({ cols: 80, rows: 24, scrollback: 5000, allowProposedApi: true });
      term.loadAddon(new TerminalOscLinkRetirementAddon());
      var redraw = '\\r\\x1b[2K\\x1b]8;;https://example.test/link\\x1b\\\\x\\x1b]8;;\\x1b\\\\';
      try {
        for (var batch = 0; batch < 16; batch++) {
          await new Promise(function (resolve) { term.write(redraw.repeat(256), resolve); });
        }
        var registry = term._core._oscLinkService._dataByLinkId;
        var cell = term.buffer.normal.getLine(0).getCell(0);
        return {
          links: registry.size,
          rows: term.buffer.normal.length,
          uri: registry.get(cell.extended.urlId).data.uri
        };
      } finally {
        term.dispose();
      }
    })();
  `).runInNewContext({
    document: {},
    navigator: { platform: 'Linux armv8l', userAgent: 'Mozilla/5.0 Chrome/74.0.3729.157' },
    console,
    setTimeout,
    clearTimeout,
    queueMicrotask,
    performance,
    URL
  })

  expect(result).toEqual({
    links: expect.any(Number),
    rows: 24,
    uri: 'https://example.test/link'
  })
  if (typeof result !== 'object' || result === null || !('links' in result)) {
    throw new Error('WebView engine did not return its link count')
  }
  expect(result.links).toBeLessThanOrEqual(1024)
})
