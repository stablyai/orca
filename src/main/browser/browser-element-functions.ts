// Page functions for Runtime.callFunctionOn; `this` is the element the agent's ref resolved to.
// A returned string is the reason the element cannot take the action.

export const FILL_ELEMENT_FUNCTION = `function (value) {
  const isTextField = (node) =>
    node?.localName === 'textarea' ||
    (node?.localName === 'input' && !/^(hidden|button|checkbox|radio|file|image|reset|submit)$/i.test(node.type));
  const findTextField = (root) => Array.from(root?.querySelectorAll?.('input, textarea') ?? []).find(isTextField) ?? null;
  let target = this;
  // Spinbutton wrappers can take the ref while another input owns the value.
  if (!isTextField(target) && target.getAttribute?.('role') === 'spinbutton') {
    const root = target.getRootNode();
    for (const id of (target.getAttribute('aria-controls') ?? '').split(/\\s+/).filter(Boolean)) {
      const controlled = root.getElementById?.(id) ?? null;
      const field = isTextField(controlled) ? controlled : findTextField(controlled);
      if (field) { target = field; break; }
    }
    if (target === this) target = findTextField(this) ?? this;
  }
  if (target.matches?.(':disabled')) return 'it is disabled';
  if (target.isContentEditable && !isTextField(target)) {
    // Rich editors revert direct DOM writes; browser edit transactions keep their models in sync.
    target.focus();
    // The edit lands wherever focus is, so a focus handler that moved it must stop the write.
    const active = target.getRootNode().activeElement;
    if (!active || !(active === target || active.contains(target) || target.contains(active))) {
      return 'it gave its focus to another element';
    }
    const selection = target.ownerDocument.defaultView?.getSelection?.();
    if (!selection) return 'its text selection is unavailable';
    selection.selectAllChildren(target);
    let edited = false;
    try {
      edited = target.ownerDocument.execCommand(value.length === 0 ? 'delete' : 'insertText', false, value) === true;
    } catch {}
    return edited ? null : 'the browser editing command failed';
  }
  if (target.localName === 'select') return 'it is a <select>; use select instead';
  if (!isTextField(target)) return 'it is not a text field or editable element';
  if (target.readOnly) return 'it is read-only';
  target.focus();
  if (!target.isConnected) return 'the page replaced it when it took focus; take a new snapshot';
  const nativeSetter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(target), 'value')?.set;
  const setValue = (next) => (nativeSetter ? nativeSetter.call(target, next) : (target.value = next));
  const previous = target.value;
  setValue(value);
  // Sanitizing fields (number, email, date) empty a value they cannot hold; handlers may clear it later.
  if (value !== '' && target.value === '') {
    setValue(previous);
    return 'the field rejected this value';
  }
  target.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
  target.dispatchEvent(new Event('change', { bubbles: true }));
  return null;
}`

// Returns whether an editable element holds focus, so a select-all shortcut would stay inside it.
export const SELECT_ALL_ELEMENT_FUNCTION = `function () {
  this.focus();
  const active = this.getRootNode().activeElement;
  const selectable = typeof this.select === 'function';
  const focused = (selectable || this.isContentEditable) && (active === this || this.contains(active));
  if (selectable) { this.select(); return focused; }
  const selection = this.ownerDocument.defaultView?.getSelection?.();
  if (!selection) return 'its text selection is unavailable';
  selection.selectAllChildren(this);
  return focused;
}`

export const SELECT_OPTION_TARGET_FUNCTION = `function () {
  if (this.localName !== 'select') {
    const role = this.getAttribute?.('role');
    return 'it is ' + (role ? 'a ' + role : '<' + this.localName + '>') + ', not a <select>; click it and choose the option instead';
  }
  return this.matches(':disabled') ? 'it is disabled' : null;
}`

export const FILE_INPUT_TARGET_FUNCTION = `function () {
  if (this.localName !== 'input' || this.type !== 'file') return 'it is not a file input';
  return this.matches(':disabled') ? 'it is disabled' : null;
}`
