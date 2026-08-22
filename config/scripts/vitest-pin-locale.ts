// Why: production code intentionally formats dates/numbers with the user's
// locale (`Intl.DateTimeFormat(undefined, …)`), but tests assert against
// English copy. On non-en-US machines those tests fail ('Sonntags' vs
// 'Sundays'). Pin the default locale to en-US for every test file so the
// suite is deterministic regardless of the developer's OS settings.
const pinnedLocale = 'en-US'

const patch = (Original) => {
  const Pinned = function (locales?: string | string[], options?: Intl.DateTimeFormatOptions) {
    return new Original(locales ?? pinnedLocale, options)
  }
  Pinned.prototype = Original.prototype
  for (const key of Object.getOwnPropertyNames(Original)) {
    if (key === 'prototype' || key === 'length' || key === 'name') continue
    const desc = Object.getOwnPropertyDescriptor(Original, key)
    if (desc) Object.defineProperty(Pinned, key, desc)
  }
  return Pinned
}

const OriginalDateTimeFormat = Intl.DateTimeFormat
const OriginalNumberFormat = Intl.NumberFormat

Intl.DateTimeFormat = patch(OriginalDateTimeFormat) as typeof Intl.DateTimeFormat
Intl.NumberFormat = patch(OriginalNumberFormat) as typeof Intl.NumberFormat

// toLocaleString/toLocaleDateString delegate to these constructors internally,
// so the constructor swap above already covers them.
export {}
