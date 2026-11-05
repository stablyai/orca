# Turkish (tr) UI Glossary and Style

Catalog: `src/renderer/src/i18n/locales/tr.json`. Missing keys fall back to English at runtime.

## Voice

- Prose and instructions use polite `siz`: `Bir dal seçin`, `hesabınız`.
- Buttons and menu items use the bare imperative: `Aç`, `Sil`, `Kaldır`, `Yeniden dene`, `İptal`.
- Failures name the action with a passive inability form: `kaydedilemedi`, `açılamadı`. Use `başarısız` only as an adjective.
- Confirmations are impersonal: `Pencere kapatılsın mı?`
- Follow the casing of the English source: title case for title-case labels (`Varsayılan Arama Motoru`), sentence case elsewhere. Keep brand names and acronyms as written.
- Labels have no final period. Use `…`, not `...`.
- A noun after a number stays singular: `{{count}} dosya`, `{{count}} commit`.

## Suffixes

- Put an apostrophe before suffixes on proper names and acronyms, and choose the suffix by how the word is pronounced: `GitHub'da`, `Orca'ya`, `SSH'yi`, `CLI'yi`, `Linear'ın`.
- English technical terms kept in English also take an apostrophe: `worktree'ler`, `commit'leri`, `branch'e`.
- Established loanwords take the suffix directly: `terminalde`, `paneli`, `modele`, `repoda`.
- When the suffix would go on the name of a UI section, rephrase instead: `Ayarlar bölümünde`, not `Ayarlar'da`.

## Terms

| English                                                            | Turkish               | Note                                                    |
| ------------------------------------------------------------------ | --------------------- | ------------------------------------------------------- |
| worktree                                                           | worktree              | Keep in English. It is a separate term from workspace.  |
| workspace                                                          | çalışma alanı         |                                                         |
| repository / repo                                                  | repository / repo     | Keep in English. Do not use `depo`.                     |
| branch, commit, pull request, merge, rebase, diff, stash, checkout | (kept in English)     | For the verb form use `merge et`, `commit'le`.          |
| base branch                                                        | temel branch          |                                                         |
| terminal                                                           | terminal              |                                                         |
| pane / panel                                                       | bölme / panel         | Keep the two terms distinct.                            |
| tab                                                                | sekme                 |                                                         |
| sidebar                                                            | kenar çubuğu          |                                                         |
| shell                                                              | kabuk                 | `PowerShell` keeps its name.                            |
| session                                                            | oturum                |                                                         |
| editor                                                             | düzenleyici           |                                                         |
| agent                                                              | ajan                  |                                                         |
| chat                                                               | sohbet                |                                                         |
| prompt                                                             | istem                 |                                                         |
| skill                                                              | beceri                | Do not use `yetenek`.                                   |
| plugin                                                             | eklenti               |                                                         |
| automation / task                                                  | otomasyon / görev     |                                                         |
| dashboard                                                          | pano                  |                                                         |
| token (LLM)                                                        | token                 | For an auth token use `belirteç`.                       |
| settings                                                           | ayarlar               |                                                         |
| shortcut / keybinding                                              | kısayol / tuş ataması |                                                         |
| sign in                                                            | oturum aç             |                                                         |
| remote (Git) / remote (host)                                       | remote / uzak         |                                                         |
| server, SSH host                                                   | sunucu, SSH sunucusu  |                                                         |
| browser                                                            | tarayıcı              |                                                         |
| review                                                             | inceleme / İncele     |                                                         |
| check (CI)                                                         | kontrol               |                                                         |
| issue                                                              | sorun                 | Product names such as `GitHub Issues` stay as they are. |
| comment, approve                                                   | yorum, onayla         |                                                         |
| delete / remove                                                    | sil / kaldır          | Keep the two terms distinct.                            |

Do not translate placeholders (`{{value0}}`), markup, commands, paths, or labels that belong to another product's UI.

## Casing (dotted and dotless I)

In Turkish, `i` uppercases to `İ` and `I` lowercases to `ı`. Code that compares or normalizes identifiers, keys, paths, or commands must not call locale-sensitive `toLocaleUpperCase()` or `toLocaleLowerCase()` without passing a locale. Use `toLowerCase()`, or pass `'en-US'` explicitly. Only text that is displayed may follow the Turkish rules.
