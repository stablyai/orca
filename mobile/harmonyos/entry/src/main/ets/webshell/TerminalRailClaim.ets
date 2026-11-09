export interface TerminalRailClaim {
  owner: string;
  canSend: boolean;
  canCompose: boolean;
  keyboardVisible: boolean;
  liveInputEnabled: boolean;
  phoneDisplayMode: boolean;
  runsAgent: boolean;
  ctrl: string;
  alt: string;
  shift: string;
  directionPadEnabled: boolean;
}

export const TERMINAL_RAIL_ARROWS: string[] = ['arrowUp', 'arrowDown', 'arrowLeft', 'arrowRight'];
const SHELL_KEYS: string[] = ['escape', 'ctrl', 'tab', 'alt', 'shift', 'char:/', 'char:|', 'char:~', 'char:-', 'char::'];
const AGENT_KEYS: string[] = ['escape', 'shiftTab', 'enter', 'ctrlC', 'ctrl', 'char:/', 'char:@', 'char:!'];

export function terminalRailKeys(claim: TerminalRailClaim): string[] {
  let toggles = ['toggleKeyboard', 'toggleDisplayMode'];
  if (claim.canCompose) { toggles.push('toggleInputMode'); }
  return toggles.concat(claim.runsAgent ? AGENT_KEYS : SHELL_KEYS, TERMINAL_RAIL_ARROWS, ['moreKeys']);
}

export function terminalRailKeyEnabled(claim: TerminalRailClaim, key: string): boolean {
  if (key === 'toggleKeyboard') { return claim.keyboardVisible || (claim.liveInputEnabled ? claim.canSend : claim.canCompose); }
  if (key === 'toggleInputMode') { return claim.canCompose; }
  return key === 'moreKeys' || claim.canSend;
}

export function parseTerminalRailClaim(owner: ESObject, toolbar: ESObject): TerminalRailClaim | null {
  if (typeof owner !== 'string' || owner.length === 0 || owner.length > 128 ||
    !toolbar || typeof toolbar !== 'object' || Array.isArray(toolbar)) { return null; }
  let buttons = toolbar as Record<string, Object>;
  if (['canSend', 'canCompose', 'keyboardVisible', 'liveInputEnabled', 'phoneDisplayMode', 'runsAgent']
    .some((key: string): boolean => typeof buttons[key] !== 'boolean') ||
    (buttons['directionPadEnabled'] !== undefined && typeof buttons['directionPadEnabled'] !== 'boolean')) { return null; }
  let modifiers = buttons['modifiers'] as Record<string, string>;
  if (!modifiers || typeof modifiers !== 'object' || Array.isArray(modifiers) ||
    ['ctrl', 'alt', 'shift'].some((key: string): boolean => !['off', 'once', 'locked'].includes(modifiers[key]))) { return null; }
  return {
    owner: owner, canSend: buttons['canSend'] === true, canCompose: buttons['canCompose'] === true,
    keyboardVisible: buttons['keyboardVisible'] === true, liveInputEnabled: buttons['liveInputEnabled'] === true,
    phoneDisplayMode: buttons['phoneDisplayMode'] === true, runsAgent: buttons['runsAgent'] === true,
    ctrl: modifiers['ctrl'], alt: modifiers['alt'], shift: modifiers['shift'],
    directionPadEnabled: buttons['directionPadEnabled'] !== false
  };
}
