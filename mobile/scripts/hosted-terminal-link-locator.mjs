import { WebSocket } from 'ws'
import { evaluateHostedDocumentWithRetry } from './hosted-webview-cdp-session.mjs'

const LINK_COLUMN = 3
const LINK_ROW_DELTAS_FROM_CURSOR = {
  javascript: 10,
  file: 7,
  http: 4
}

export async function readHostedTerminalLinkPoints(document, operations = {}) {
  const evaluate = operations.evaluate ?? evaluateHostedDocumentWithRetry
  const geometry = JSON.parse(
    await evaluate(
      document,
      `(() => {
        const terminal = document.querySelector('.xterm');
        const screenElement = document.querySelector('.xterm-screen');
        const textarea = document.querySelector('.xterm-helper-textarea');
        const terminalRect = terminal?.getBoundingClientRect();
        const screenRect = screenElement?.getBoundingClientRect();
        if (!(terminal instanceof HTMLElement) ||
            !(screenElement instanceof HTMLElement) ||
            !(textarea instanceof HTMLTextAreaElement) ||
            !terminalRect ||
            !screenRect ||
            terminalRect.width <= 0 ||
            terminalRect.height <= 0 ||
            screenRect.width <= 0 ||
            screenRect.height <= 0) return '';
        const xterm = findTerminal(terminal);
        const rowElements = Array.from(screenElement.querySelectorAll('.xterm-rows > div'));
        const visibleRows = xterm
          ? Array.from({ length: xterm.rows }, (_, index) => ({
              index,
              text: String(
                xterm.buffer.active
                  .getLine(xterm.buffer.active.viewportY + index)
                  ?.translateToString(true) ?? ''
              )
            }))
          : rowElements.map((row, index) => ({
              index,
              text: String(row.textContent ?? '')
            }));
        const rowFor = (label, occurrence = 0) => {
          const matches = visibleRows.filter((row) => row.text.includes(label));
          return matches[occurrence]?.index ?? null;
        };
        return JSON.stringify({
          cellHeight: Number.parseFloat(textarea.style.height),
          cellWidth: Number.parseFloat(textarea.style.width),
          cursorTop: Number.parseFloat(textarea.style.top),
          innerHeight: Number(innerHeight),
          linkRows: {
            file: rowFor('ORCA_FILE'),
            fileAlternate: rowFor('ORCA_FILE', 1),
            http: rowFor('ORCA_HTTP'),
            javascript: rowFor('ORCA_JS')
          },
          xtermFound: Boolean(xterm),
          screenRect: {
            height: screenRect.height,
            width: screenRect.width
          },
          terminalRect: {
            bottom: terminalRect.bottom,
            height: terminalRect.height,
            left: terminalRect.left,
            top: terminalRect.top,
            width: terminalRect.width
          },
          screenHeight: Number(screen.height),
          screenWidth: Number(screen.width)
        });

        function findTerminal(element) {
          for (
            let ancestor = element;
            ancestor instanceof HTMLElement;
            ancestor = ancestor.parentElement
          ) {
            const fiberKey = Object.keys(ancestor).find((key) => key.startsWith('__reactFiber$'));
            let fiber = fiberKey ? ancestor[fiberKey] : null;
            for (let depth = 0; fiber && depth < 32; depth += 1, fiber = fiber.return) {
              let hook = fiber.memoizedState;
              for (let index = 0; hook && index < 32; index += 1, hook = hook.next) {
                const current = hook.memoizedState?.current;
                if (
                  current &&
                  Number.isInteger(current.cols) &&
                  Number.isInteger(current.rows) &&
                  current.buffer?.active
                ) return current;
              }
            }
          }
          return null;
        }
      })()`,
      WebSocket
    )
  )
  return hostedTerminalLinkPointsFromGeometry(geometry)
}

export async function describeHostedTerminalLinkPoint(document, point, operations = {}) {
  const evaluate = operations.evaluate ?? evaluateHostedDocumentWithRetry
  const value = await evaluate(
    document,
    `(() => {
      const point = ${JSON.stringify(point)};
      const viewportTop = Math.max(0, screen.height - innerHeight);
      const clientX = point.x * screen.width;
      const clientY = point.y * screen.height - viewportTop;
      const target = document.elementFromPoint(clientX, clientY);
      const terminalElement = target?.closest('.xterm') ?? document.querySelector('.xterm');
      const terminal = findTerminal(terminalElement);
      const terminalRect = terminalElement?.getBoundingClientRect();
      const column = terminal && terminalRect
        ? Math.floor((clientX - terminalRect.left) / (terminalRect.width / terminal.cols))
        : null;
      const viewportRow = terminal && terminalRect
        ? Math.floor((clientY - terminalRect.top) / (terminalRect.height / terminal.rows))
        : null;
      const bufferRow = terminal && viewportRow !== null
        ? terminal.buffer.active.viewportY + viewportRow
        : null;
      const rows = terminal && bufferRow !== null
        ? Array.from({ length: 13 }, (_, index) => bufferRow + index - 6)
          .filter((row) => row >= 0)
          .map((row) => describeRow(terminal, row))
        : [];
      return JSON.stringify({
        buffer: terminal ? {
          baseY: terminal.buffer.active.baseY,
          bufferRow,
          column,
          cursorX: terminal.buffer.active.cursorX,
          cursorY: terminal.buffer.active.cursorY,
          rows,
          terminalRows: terminal.rows,
          viewportRow,
          viewportY: terminal.buffer.active.viewportY
        } : null,
        lifecycle: Array.isArray(globalThis.__orcaMobileTerminalDiagnostics)
          ? globalThis.__orcaMobileTerminalDiagnostics.slice(-24)
          : [],
        clientX,
        clientY,
        className: typeof target?.className === 'string' ? target.className : '',
        screenHeight: screen.height,
        screenWidth: screen.width,
        tagName: target?.tagName ?? null,
        terminalHit: Boolean(target?.closest('.xterm')),
        viewportTop
      });

      function findTerminal(element) {
        for (
          let ancestor = element;
          ancestor instanceof HTMLElement;
          ancestor = ancestor.parentElement
        ) {
          const fiberKey = Object.keys(ancestor).find((key) => key.startsWith('__reactFiber$'));
          let fiber = fiberKey ? ancestor[fiberKey] : null;
          for (let depth = 0; fiber && depth < 32; depth += 1, fiber = fiber.return) {
            let hook = fiber.memoizedState;
            for (let index = 0; hook && index < 32; index += 1, hook = hook.next) {
              const current = hook.memoizedState?.current;
              if (
                current &&
                Number.isInteger(current.cols) &&
                Number.isInteger(current.rows) &&
                current.buffer?.active
              ) return current;
            }
          }
        }
        return null;
      }

      function describeRow(terminal, row) {
        const line = terminal.buffer.active.getLine(row);
        const links = [];
        if (line) {
          for (let column = 0; column < Math.min(line.length, 80); column += 1) {
            const id = line.getCell(column)?.extended?.urlId;
            if (id && !links.some((link) => link.id === id)) {
              links.push({ id, uri: readUri(terminal, id) });
            }
          }
        }
        return {
          links,
          row,
          text: String(line?.translateToString(true) ?? '').slice(0, 160)
        };
      }

      function readUri(terminal, id) {
        try {
          const core = terminal._core;
          const service = core?._oscLinkService ?? core?._inputHandler?._oscLinkService;
          return String(service?.getLinkData?.(id)?.uri ?? '').slice(0, 256);
        } catch {
          return '';
        }
      }
    })()`,
    WebSocket
  )
  return JSON.parse(value)
}

export function hostedTerminalLinkPointsFromGeometry(geometry) {
  validateGeometry(geometry)
  const columns = Math.round(geometry.screenRect.width / geometry.cellWidth)
  const rows = Math.round(geometry.screenRect.height / geometry.cellHeight)
  const cursorRow = Math.round(geometry.cursorTop / geometry.cellHeight)
  const cursorAnchor =
    cursorRow >= LINK_ROW_DELTAS_FROM_CURSOR.javascript && cursorRow < rows ? cursorRow : rows - 1
  const contentRows = geometry.linkRows
  const hasContentRows =
    contentRows &&
    ['javascript', 'file', 'fileAlternate', 'http'].every(
      (kind) =>
        Number.isInteger(contentRows[kind]) && contentRows[kind] >= 0 && contentRows[kind] < rows
    )
  if (geometry.xtermFound === true && !hasContentRows) {
    throw new Error('Hosted terminal link corpus is not present in the visible xterm buffer')
  }
  if (
    columns <= LINK_COLUMN ||
    (!hasContentRows &&
      (rows <= LINK_ROW_DELTAS_FROM_CURSOR.javascript ||
        cursorAnchor < LINK_ROW_DELTAS_FROM_CURSOR.javascript)) ||
    Math.abs(columns * geometry.cellWidth - geometry.screenRect.width) > geometry.cellWidth ||
    Math.abs(rows * geometry.cellHeight - geometry.screenRect.height) > geometry.cellHeight ||
    Math.abs(cursorRow * geometry.cellHeight - geometry.cursorTop) > geometry.cellHeight / 2
  ) {
    throw new Error(
      `Hosted terminal link grid is invalid: ${JSON.stringify({
        columns,
        cursorAnchor,
        cursorRow,
        rows,
        screenHeight: geometry.screenRect.height,
        screenWidth: geometry.screenRect.width
      })}`
    )
  }
  const viewportTop = Math.max(0, geometry.screenHeight - geometry.innerHeight)
  const cellWidth = geometry.terminalRect.width / columns
  const cellHeight = geometry.terminalRect.height / rows
  const point = (row) => ({
    x: (geometry.terminalRect.left + (LINK_COLUMN + 0.5) * cellWidth) / geometry.screenWidth,
    y: (viewportTop + geometry.terminalRect.top + (row + 0.5) * cellHeight) / geometry.screenHeight
  })
  const points = {
    javascript: point(
      hasContentRows
        ? contentRows.javascript
        : cursorAnchor - LINK_ROW_DELTAS_FROM_CURSOR.javascript
    ),
    file: point(
      hasContentRows ? contentRows.file : cursorAnchor - LINK_ROW_DELTAS_FROM_CURSOR.file
    ),
    fileAlternate: point(
      hasContentRows
        ? contentRows.fileAlternate
        : cursorAnchor - (LINK_ROW_DELTAS_FROM_CURSOR.file - 1)
    ),
    http: point(hasContentRows ? contentRows.http : cursorAnchor - LINK_ROW_DELTAS_FROM_CURSOR.http)
  }
  for (const candidate of Object.values(points)) {
    if (
      !Number.isFinite(candidate.x) ||
      !Number.isFinite(candidate.y) ||
      candidate.x < 0 ||
      candidate.x > 1 ||
      candidate.y < 0 ||
      candidate.y > 1
    ) {
      throw new Error('Hosted terminal link point is invalid')
    }
  }
  return points
}

function validateGeometry(geometry) {
  const values = [
    geometry?.cellHeight,
    geometry?.cellWidth,
    geometry?.cursorTop,
    geometry?.innerHeight,
    geometry?.screenHeight,
    geometry?.screenWidth,
    geometry?.screenRect?.height,
    geometry?.screenRect?.width,
    geometry?.terminalRect?.bottom,
    geometry?.terminalRect?.height,
    geometry?.terminalRect?.left,
    geometry?.terminalRect?.top,
    geometry?.terminalRect?.width
  ]
  if (
    values.some((value) => !Number.isFinite(value)) ||
    geometry.cellHeight <= 0 ||
    geometry.cellWidth <= 0 ||
    geometry.screenHeight <= 0 ||
    geometry.screenWidth <= 0 ||
    geometry.screenRect.height <= 0 ||
    geometry.screenRect.width <= 0 ||
    geometry.terminalRect.height <= 0 ||
    geometry.terminalRect.width <= 0
  ) {
    throw new Error('Hosted terminal link surface was not found')
  }
}
