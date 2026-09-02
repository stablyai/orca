export function focusedValueSetExpression(
  valueExpression: string,
  options?: { append?: boolean; dispatchEvents?: boolean }
): string {
  const nextValue = options?.append
    ? ["String(target.value ?? '') + ", valueExpression].join('')
    : valueExpression
  const dispatchEvents = options?.dispatchEvents
    ? " target.dispatchEvent(new Event('input', { bubbles: true })); target.dispatchEvent(new Event('change', { bubbles: true }));"
    : ''
  return [
    '(() => { const el = document.activeElement; if (el) {',
    // Why: ARIA spinbutton wrappers can hold focus while a contained or controlled input owns the value.
    " const editableSelector = \"input:not([type='hidden']):not([type='button']):not([type='checkbox']):not([type='radio']):not([type='file']):not([type='image']):not([type='reset']):not([type='submit']), textarea\";",
    " const isEditable = (node) => !!node && (node.matches?.(editableSelector) ?? (node.tagName === 'TEXTAREA' || (node.tagName === 'INPUT' && !/^(hidden|button|checkbox|radio|file|image|reset|submit)$/i.test(node.getAttribute?.('type') ?? ''))));",
    ' const findEditable = (root) => root?.querySelector?.(editableSelector) ?? null;',
    ' let target = el;',
    " if (!isEditable(target) && target.getAttribute?.('role') === 'spinbutton') {",
    "   const controls = target.getAttribute('aria-controls');",
    '   if (controls) { for (const id of controls.split(/\\s+/)) { if (!id) continue; const controlled = document.getElementById(id); if (isEditable(controlled)) { target = controlled; break; } const descendant = findEditable(controlled); if (descendant) { target = descendant; break; } } }',
    '   if (target === el) { const descendant = findEditable(target); if (descendant) target = descendant; }',
    ' }',
    " const nativeSetter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(target), 'value')?.set;",
    ' const nextValue = ',
    nextValue,
    '; if (nativeSetter) { nativeSetter.call(target, nextValue); } else { target.value = nextValue; }',
    dispatchEvents,
    ' } })()'
  ].join('')
}

// Why: rich editors reconcile only real browser edit transactions; a direct-DOM fallback can leave their model stale.
export function focusedRichTextEditExpression(
  valueExpression: string,
  options?: { selectAll?: boolean }
): string {
  const selectAll = options?.selectAll ? 'true' : 'false'
  return [
    '(() => {',
    ' const target = document.activeElement;',
    ' const value = ',
    valueExpression,
    ';',
    ` const selectAll = ${selectAll};`,
    " const isEditable = target?.isContentEditable === true || /^(|true|plaintext-only)$/i.test(target?.getAttribute?.('contenteditable') ?? 'false');",
    " if (!target || target === document.body || !isEditable) { throw new Error('Focused rich-text target is unavailable'); }",
    ' if (selectAll) {',
    "   if (typeof window.getSelection !== 'function') { throw new Error('Rich-text selection is unavailable'); }",
    '   const selection = window.getSelection();',
    "   if (!selection) { throw new Error('Rich-text selection is unavailable'); }",
    '   selection.selectAllChildren(target);',
    ' }',
    " const editCommand = selectAll && value.length === 0 ? 'delete' : 'insertText';",
    ' let edited = false;',
    ' try {',
    '   edited = document.execCommand(editCommand, false, value) === true;',
    ' } catch { edited = false; }',
    " if (!edited) { throw new Error('Browser rich-text editing command failed'); }",
    ' })()'
  ].join('')
}

export function isExplicitContentEditableResult(result: unknown): boolean {
  const value =
    result && typeof result === 'object' ? (result as { value?: unknown }).value : undefined
  return typeof value === 'string' && /^(|true|plaintext-only)$/i.test(value)
}
