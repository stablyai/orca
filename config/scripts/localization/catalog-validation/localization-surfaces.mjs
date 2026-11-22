import path from 'node:path'

// Copy both surfaces render; each resolves it in its own catalog through an injected translator.
const USAGE_STATUS_COPY_ROOT = path.join('src', 'shared', 'agent-usage', 'status-copy')

// Desktop and mobile ship separate catalogs under one contract: same call shape, key rules and gates.
export const LOCALIZATION_SURFACES = {
  desktop: {
    localesDir: path.join('src', 'renderer', 'src', 'i18n', 'locales'),
    sourceRoots: [
      path.join('src', 'renderer', 'src'),
      path.join('src', 'main'),
      // Shared copy the desktop draws (the phone draws it too).
      path.join('src', 'shared', 'bots', 'bot-item-note-lines.ts'),
      path.join('src', 'shared', 'bots', 'bot-first-look-words.ts'),
      path.join('src', 'shared', 'bots', 'bot-failure-copy.ts'),
      path.join('src', 'shared', 'connectors', 'connector-message-asker-view.ts'),
      path.join('src', 'shared', 'bots', 'bot-item-status-name.ts'),
      path.join('src', 'shared', 'agent-session', 'journal', 'agent-journal-typed-by.ts'),
      path.join(
        'src',
        'shared',
        'agent-session',
        'lifecycle',
        'accounts',
        'agent-session-usage-account-label.ts'
      ),
      USAGE_STATUS_COPY_ROOT
    ],
    runtimeRequiredPath: path.join('src', 'renderer', 'src', 'i18n', 'en-runtime-required.json'),
    // Desktop runtimes load built-in catalogs as-is; plural forms CLDR adds beyond `_other` are committed.
    fillsPluralForms: true,
    syncCatalogCommand: 'pnpm run sync:localization-catalog',
    syncRuntimeCatalogCommand: 'pnpm run sync:localization-runtime-catalog'
  },
  mobile: {
    localesDir: path.join('mobile', 'src', 'i18n', 'locales'),
    sourceRoots: [
      path.join('mobile', 'app'),
      path.join('mobile', 'src'),
      path.join('mobile', 'web-entry'),
      // Shared copy helpers the phone draws, so its catalog keeps their plural families.
      path.join('src', 'shared', 'bots', 'bot-chat-tree.ts'),
      path.join('src', 'shared', 'bots', 'bot-sidebar-tree.ts'),
      path.join('src', 'shared', 'bots', 'bot-chat-tree-view.ts'),
      path.join('src', 'shared', 'bots', 'bot-row-line.ts'),
      path.join('src', 'shared', 'bots', 'bot-item-note-lines.ts'),
      path.join('src', 'shared', 'bots', 'bot-first-look-words.ts'),
      path.join('src', 'shared', 'bots', 'bot-failure-copy.ts'),
      path.join('src', 'shared', 'bots', 'bot-item-status-name.ts'),
      path.join('src', 'shared', 'bots', 'bot-group-remote-ask-lines.ts'),
      path.join('src', 'shared', 'connectors', 'connector-message-asker-view.ts'),
      path.join('src', 'shared', 'agent-session', 'journal', 'agent-journal-typed-by.ts'),
      path.join(
        'src',
        'shared',
        'agent-session',
        'lifecycle',
        'accounts',
        'agent-session-usage-account-label.ts'
      ),
      USAGE_STATUS_COPY_ROOT
    ],
    runtimeRequiredPath: path.join('mobile', 'src', 'i18n', 'en-runtime-required.json'),
    syncCatalogCommand: 'pnpm run sync:mobile-localization',
    syncRuntimeCatalogCommand: 'pnpm run sync:mobile-localization'
  }
}

export function readLocalizationSurface(argv) {
  const index = argv.indexOf('--surface')
  const name = index === -1 ? 'desktop' : argv[index + 1]
  const surface = Object.hasOwn(LOCALIZATION_SURFACES, name) ? LOCALIZATION_SURFACES[name] : null
  if (!surface) {
    throw new Error(`Unknown localization surface: ${String(name)}`)
  }
  return surface
}
