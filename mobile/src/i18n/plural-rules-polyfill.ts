// Hermes has no Intl.PluralRules; without it i18next applies English one/other to every language.
// One file per base language: plural rules do not vary by region or script.
import '@formatjs/intl-pluralrules/polyfill.js'
import '@formatjs/intl-pluralrules/locale-data/de.js'
import '@formatjs/intl-pluralrules/locale-data/en.js'
import '@formatjs/intl-pluralrules/locale-data/es.js'
import '@formatjs/intl-pluralrules/locale-data/fr.js'
import '@formatjs/intl-pluralrules/locale-data/ja.js'
import '@formatjs/intl-pluralrules/locale-data/ko.js'
import '@formatjs/intl-pluralrules/locale-data/pt.js'
import '@formatjs/intl-pluralrules/locale-data/ru.js'
import '@formatjs/intl-pluralrules/locale-data/tr.js'
import '@formatjs/intl-pluralrules/locale-data/zh.js'
