export interface TerminalShortcut { id: string; label: string; }
export interface CustomShortcut { id: string; label: string; bytes: string; enter: boolean; visible: boolean; }
export const TERMINAL_SHORTCUTS: TerminalShortcut[] = [
  { id: 'escape', label: 'Esc' }, { id: 'tab', label: 'Tab' }, { id: 'enter', label: 'Enter' },
  { id: 'shiftTab', label: 'Shift+Tab' }, { id: 'space', label: 'Space' }, { id: 'backspace', label: '⌫' },
  { id: 'delete', label: 'Del' }, { id: 'arrowUp', label: '↑' }, { id: 'arrowDown', label: '↓' },
  { id: 'arrowLeft', label: '←' }, { id: 'arrowRight', label: '→' }, { id: 'ctrlC', label: 'Ctrl+C' },
  { id: 'ctrlD', label: 'Ctrl+D' }, { id: 'ctrlL', label: 'Ctrl+L' }, { id: 'ctrlZ', label: 'Ctrl+Z' },
  { id: 'ctrlR', label: 'Ctrl+R' }, { id: 'ctrlA', label: 'Ctrl+A' }, { id: 'ctrlE', label: 'Ctrl+E' },
  { id: 'ctrlW', label: 'Ctrl+W' }, { id: 'ctrlU', label: 'Ctrl+U' }
];
export function shortcutLabel(id: string): string {
  let row = TERMINAL_SHORTCUTS.find((item: TerminalShortcut): boolean => item.id === id);
  return row ? row.label : id;
}
