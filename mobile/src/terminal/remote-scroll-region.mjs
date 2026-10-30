/** Whether a wheel report's redraw can be shown sliding: WebGL, no selection, a program's screen. */
export function canPresentRemoteScroll(terminal) {
  const mode = terminal.modes?.mouseTrackingMode
  return (
    Boolean(terminal._core?._renderService?._renderer?.value?._gl) &&
    !terminal.hasSelection?.() &&
    (terminal.buffer?.active.type === 'alternate' || ['vt200', 'drag', 'any'].includes(mode))
  )
}

export function remoteScrollFrameIdentity(terminal, renderer) {
  return JSON.stringify([
    terminal.rows,
    terminal.cols,
    renderer.dimensions.css.cell.height,
    terminal.options?.fontSize,
    terminal.options?.fontFamily,
    terminal.options?.fontWeight,
    terminal.options?.fontWeightBold,
    terminal.options?.theme
  ])
}

// Compare rendered cells as well as text: a moved label with different colors is a new frame.
export function remoteScrollRows(terminal) {
  const rows = []
  let reusableCell
  for (let row = 0; row < terminal.rows; row++) {
    const line = terminal.buffer.active.getLine(terminal.buffer.active.viewportY + row)
    if (!line) {
      return null
    }
    const styles = []
    let previousStyle = ''
    for (let col = 0; col < terminal.cols; col++) {
      const cell = line.getCell(col, reusableCell)
      if (!cell || typeof cell.fg !== 'number' || typeof cell.bg !== 'number') {
        return null
      }
      reusableCell = cell
      const style = [cell.fg, cell.bg, cell.extended?.ext ?? 0].join(',')
      if (style !== previousStyle) {
        styles.push([col, style])
        previousStyle = style
      }
    }
    const text = line.translateToString(false)
    rows.push({ text, key: JSON.stringify([text, styles]) })
  }
  return rows
}

/**
 * The span of rows a program moved between two frames, by `delta` rows in `direction`, or null.
 * Only rows that occur once in both frames and carry text vouch for a move; a fixed header or
 * input line above or below the span stays out of it.
 */
export function findRemoteScrollRegion(before, after, direction) {
  if (!before || !after || before.length !== after.length || !direction) {
    return null
  }
  const count = (rows) => {
    const counts = new Map()
    for (const row of rows) {
      counts.set(row.key, (counts.get(row.key) ?? 0) + 1)
    }
    return counts
  }
  const oldCounts = count(before),
    newCounts = count(after),
    candidates = []
  for (let magnitude = 1; magnitude <= Math.floor(after.length / 2); magnitude++) {
    const delta = Math.sign(direction) * magnitude
    const pairs = []
    for (let row = 0; row < after.length; row++) {
      const old = row - delta,
        current = after[row]
      if (
        old >= 0 &&
        old < before.length &&
        current.text.trim().length >= 4 &&
        oldCounts.get(current.key) === 1 &&
        newCounts.get(current.key) === 1 &&
        before[old].key === current.key
      ) {
        pairs.push([old, row])
      }
    }
    if (pairs.length < 4) {
      continue
    }
    const start = Math.min(...pairs.flat()),
      end = Math.max(...pairs.flat())
    // Why: a real screen can be mostly blank rows, so a share of matched rows rejected it. The
    // check below instead requires every row in the span, blank or not, to have moved the same way.
    let consistent = true
    for (let row = start; row <= end; row++) {
      const old = row - delta
      if (old >= start && old <= end && before[old].key !== after[row].key) {
        consistent = false
      }
    }
    if (consistent) {
      candidates.push({ start, end, delta, matches: pairs.length })
    }
  }
  candidates.sort((a, b) => b.matches - a.matches)
  return candidates.length && (!candidates[1] || candidates[0].matches > candidates[1].matches)
    ? candidates[0]
    : null
}

export function remoteScrollTranslation(element) {
  if (!element) {
    return 0
  }
  const matrix = getComputedStyle(element).transform
  if (matrix === 'none') {
    return 0
  }
  const values = matrix
    .match(/matrix(?:3d)?\(([^)]+)\)/)?.[1]
    .split(',')
    .map(Number)
  return values?.length === 6 ? values[5] : values?.length === 16 ? values[13] : 0
}
