// Session-level configuration for each IBus engine the native terminal IME E2E
// runner can drive. Keystrokes and expected text live with the Playwright spec
// (tests/e2e/terminal-ibus-engine-input-profiles.ts); the two lists must agree,
// which config/scripts/terminal-ime-e2e-workflow.test.mjs enforces.
//
// Only the hangul entry has been run. Every other engine's schema id, key names
// and value encoding are transcribed from that engine's upstream source for the
// version Ubuntu 22.04 (jammy) ships, not read off an installed schema, so treat
// them as unverified until CI has run green. They are not inferred from
// ibus-hangul: the four engines share no namespace and no key names, and a wrong
// id fails loudly in configureEngine rather than silently mis-configuring.

/**
 * @typedef {object} TerminalIbusEngineProfile
 * @property {string} aptPackage Package installed by the workflow matrix.
 * @property {string} ibusEngineName Argument to `ibus engine`; case-sensitive.
 * @property {Array<[string, string, string]>} gsettings schema id, key, value.
 * @property {boolean} expectationsVerified False while the committed text is a
 *   prediction from engine source rather than a recorded CI run.
 */

/** @type {Record<string, TerminalIbusEngineProfile>} */
export const terminalIbusEngineProfiles = {
  // ibus-hangul 1.5.4-1build2. Unchanged from the original single-engine runner.
  hangul: {
    aptPackage: 'ibus-hangul',
    ibusEngineName: 'hangul',
    gsettings: [
      ['org.freedesktop.ibus.engine.hangul', 'initial-input-mode', 'hangul'],
      ['org.freedesktop.ibus.engine.hangul', 'hangul-keyboard', '2']
    ],
    expectationsVerified: true
  },

  // ibus-libpinyin 1.12.1-2ubuntu2. Schema id comes from PinyinConfig's
  // g_settings_new argument, not from the org.freedesktop.ibus namespace.
  // Cloud input, emoji candidates and post-commit suggestions are switched off
  // so the candidate list is a pure function of the bundled libpinyin model.
  libpinyin: {
    aptPackage: 'ibus-libpinyin',
    ibusEngineName: 'libpinyin',
    gsettings: [
      ['com.github.libpinyin.ibus-libpinyin.libpinyin', 'init-chinese', 'true'],
      ['com.github.libpinyin.ibus-libpinyin.libpinyin', 'init-full', 'false'],
      ['com.github.libpinyin.ibus-libpinyin.libpinyin', 'init-full-punct', 'false'],
      ['com.github.libpinyin.ibus-libpinyin.libpinyin', 'double-pinyin', 'false'],
      ['com.github.libpinyin.ibus-libpinyin.libpinyin', 'enable-cloud-input', 'false'],
      ['com.github.libpinyin.ibus-libpinyin.libpinyin', 'emoji-candidate', 'false'],
      ['com.github.libpinyin.ibus-libpinyin.libpinyin', 'show-suggestion', 'false']
    ],
    expectationsVerified: false
  },

  // ibus-anthy 1.5.14-1. input-mode defaults to 3 (Latin), so leaving it alone
  // would type ASCII and never start a composition; 0 is Hiragana and 0 for
  // typing-method is Romaji.
  anthy: {
    aptPackage: 'ibus-anthy',
    ibusEngineName: 'anthy',
    gsettings: [
      ['org.freedesktop.ibus.engine.anthy.common', 'input-mode', '0'],
      ['org.freedesktop.ibus.engine.anthy.common', 'typing-method', '0']
    ],
    expectationsVerified: false
  },

  // ibus-unikey 0.7.0~beta1-1build2. Telex and Unicode are already the schema
  // defaults; they are pinned so a distro patch cannot silently retarget the
  // keystroke script.
  unikey: {
    aptPackage: 'ibus-unikey',
    ibusEngineName: 'Unikey',
    gsettings: [
      ['org.freedesktop.ibus.engine.unikey', 'input-method', 'telex'],
      ['org.freedesktop.ibus.engine.unikey', 'output-charset', 'unicode'],
      ['org.freedesktop.ibus.engine.unikey', 'spell-check', 'true'],
      ['org.freedesktop.ibus.engine.unikey', 'macro-enabled', 'false']
    ],
    expectationsVerified: false
  }
}

export const defaultTerminalIbusEngineId = 'hangul'

export function terminalIbusEngineIds() {
  return Object.keys(terminalIbusEngineProfiles)
}

export function resolveTerminalIbusEngineProfile(engineId) {
  const profile = terminalIbusEngineProfiles[engineId]
  if (!profile) {
    throw new Error(
      `Unknown IBus engine "${engineId}"; expected one of ${terminalIbusEngineIds().join(', ')}`
    )
  }
  return profile
}
