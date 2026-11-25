import assert from 'node:assert/strict'

export async function geometry(page) {
  return page.evaluate(() => {
    const rect = (element) => element?.getBoundingClientRect().toJSON()
    const field = document.querySelector('input[type=search]')
    const split = field.closest('[data-sidebar-bots-split]')
    const viewport = split.closest('[data-sidebar-content-viewport]')
    const panel = field.closest('[data-bot-sidebar-search]')
    const scroller = panel.querySelector('.bot-sidebar-scrollbar')
    const projects = viewport.querySelector('[data-sidebar-projects-list]')
    const rows = [...panel.querySelectorAll('[data-bot-search-result]')]
    return {
      field: rect(field),
      ring: getComputedStyle(field).boxShadow,
      split: rect(split),
      viewport: rect(viewport),
      outerScroll: viewport.scrollTop,
      outerHeight: viewport.scrollHeight,
      shell: rect(document.querySelector('[data-sidebar-window]')),
      toolbar: rect(viewport.nextElementSibling),
      handle: rect(split.querySelector('[role=separator]')),
      projects: rect(projects),
      projectsScroll: projects.scrollTop,
      scroller: rect(scroller),
      scroll: scroller?.scrollTop,
      scrollHeight: scroller?.scrollHeight,
      clientHeight: scroller?.clientHeight,
      rows: rows.map((row) => ({
        id: row.dataset.botSearchResult,
        box: rect(row),
        clientHeight: row.clientHeight,
        scrollHeight: row.scrollHeight,
        lines: row.lastElementChild.children.length,
        overflow: getComputedStyle(row).overflowY
      }))
    }
  })
}

export function checkRows(g) {
  assert.ok(
    g.rows.some((row) => row.lines === 1),
    'name-only results exist'
  )
  assert.ok(
    g.rows.some((row) => row.lines === 2),
    'name + detail results exist'
  )
  for (const row of g.rows) {
    assert.equal(row.overflow, 'hidden', `${row.id}: probe the actual clipped card surface`)
    assert.ok(
      row.scrollHeight <= row.clientHeight,
      `${row.id}: content compressed: scrollHeight ${row.scrollHeight} > clientHeight ${row.clientHeight}`
    )
  }
}

export function checkShell(g, folded) {
  assert.notEqual(g.ring, 'none', 'focused field has a visible ring')
  assert.ok(g.field.top - 3 >= g.viewport.top, 'top of field ring visible')
  assert.ok(
    g.field.left - 3 >= g.split.left && g.field.right + 3 <= g.split.right,
    'sides of ring visible'
  )
  assert.ok(g.field.bottom + 3 <= g.scroller.top, 'ring clears the results viewport')
  assert.ok(g.scroller.bottom <= g.split.bottom, 'results contained by split')
  assert.ok(g.toolbar.bottom <= g.shell.bottom, 'toolbar remains inside shell')
  assert.ok(g.split.bottom <= g.toolbar.top, 'split above toolbar')
  if (!folded) {
    assert.ok(g.projects.height >= 120, 'Projects retains its list minimum')
    assert.ok(g.projects.top >= g.split.bottom, 'no Bots paint into Projects')
    assert.ok(
      g.handle.top >= g.viewport.top && g.handle.bottom <= g.viewport.bottom,
      'entire resize target visible'
    )
  }
}
