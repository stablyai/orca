# Polish (pl) UI Glossary and Style

Catalog: `src/renderer/src/i18n/locales/pl.json` (desktop) and `mobile/src/i18n/locales/pl.json` (Orca Mobile). Missing keys fall back to English at runtime. System detection maps `pl`, `pl-PL` and POSIX tags such as `pl_PL.UTF-8` to `pl`.

## Voice

- Address the user informally (`Ty`), but avoid pronouns where a neutral phrasing works: `Wybierz gałąź`, `Nie znaleziono worktree`, `Nie udało się zapisać pliku.`
- Avoid grammatical gender for the user: `Zalogowano`, not `Zalogowałeś się`.
- Buttons, menu items and commands use the imperative, second person singular: `Otwórz`, `Zapisz`, `Usuń`, `Spróbuj ponownie`, `Anuluj`.
- Failures: prefer `Nie udało się …` (`Nie udało się zapisać pliku.`). A noun status such as `Aktualizacja nie powiodła się` is fine for short labels; do not translate `X failed` word for word when the sentence reads better with `Nie udało się`.
- Confirmations are impersonal questions: `Zamknąć okno?`, `Usunąć worktree?`
- Polish has no title case. Capitalize the first word and proper nouns only, even when the English label uses title case. Keep brand names and acronyms as written.
- Labels have no final period. Keep `…` or `...` exactly as the source has it. Use Polish quotes `„…”` in prose and when quoting another label (`wybierz „Pełny dostęp”`); keep backticks and code quoting as in the source.
- Polish strings run about 20–30% longer than English. Prefer the shorter natural wording for buttons, tabs and badges, but never drop meaning.
- Interpolated names (`{{name}}`, `{{agent}}`, `{{host}}`, `{{server}}`) stay in the nominative and never inflect. Build the sentence around them: `na hoście {{host}}`, `do agenta {{agent}}`, `Nie udało się uruchomić: {{agent}}`, never `na {{host}}` or `z {{agent}}`.
- `Orca` does not inflect: `w Orca`, `do Orca`, `aplikacji Orca`.
- Plurals use Polish CLDR forms. Every family with `_other` also has `_few` (2–4, 22–24…) and `_many` (0, 5–21, 25…); `_other` covers fractions. Write natural counted phrases (`1 plik`, `3 pliki`, `5 plików`) and keep `{{count}}` wherever the English form has it. Agents are masculine personal: `3 agentów`, `5 agentów`.
- When a fragment is concatenated into another string, translate it for the final sentence (case, gender, word order), not in isolation.

## Terms

Keep Git and developer terms that Polish developers use in English. The table lists the forms to use.

| English                            | Polish                                          | Note                                                                 |
| ---------------------------------- | ----------------------------------------------- | -------------------------------------------------------------------- |
| worktree                           | worktree (n., indeclinable)                     | `usuń worktree`, `w worktree`. Distinct from workspace.              |
| workspace                          | przestrzeń robocza                              | Never `obszar roboczy`.                                              |
| floating workspace                 | pływająca przestrzeń robocza                    |                                                                      |
| repository / repo                  | repozytorium / repo                             |                                                                      |
| branch / base branch               | gałąź / gałąź bazowa                            |                                                                      |
| commit                             | commit; action `Zatwierdź`, prose `zrób commit` |                                                                      |
| pull request / PR                  | pull request / PR                               | `merge request` stays `merge request` (GitLab).                      |
| push / pull / fetch                | wypchnij / pobierz zmiany / pobierz (fetch)     |                                                                      |
| merge / rebase / squash            | scal / rebase / połącz commity                  |                                                                      |
| stage / unstage                    | dodaj do poczekalni / usuń z poczekalni         |                                                                      |
| diff                               | diff / różnice                                  |                                                                      |
| fork (repository) / fork (session) | fork / odgałęzienie                             |                                                                      |
| remote (Git) / remote host         | remote / host zdalny                            | Adjective: `zdalny`.                                                 |
| issue                              | zgłoszenie                                      |                                                                      |
| review                             | przegląd                                        | A PR/MR badge may read `PR/MR`; a delete safety check `sprawdzenie`. |
| check (CI)                         | kontrola / testy CI                             |                                                                      |
| source control                     | kontrola wersji                                 |                                                                      |
| agent / coding agent               | agent / agent kodujący                          | Plural `agenci`; genitive plural `agentów`.                          |
| subagent / child agent             | subagent / agent podrzędny                      |                                                                      |
| skill                              | umiejętność                                     | Never `skill`.                                                       |
| plugin / catalog (plugins)         | plugin / katalog                                |                                                                      |
| prompt / session / chat            | prompt / sesja / czat                           |                                                                      |
| terminal / shell                   | terminal / powłoka                              |                                                                      |
| daemon                             | daemon                                          | Genitive `daemona`. Never `demon`.                                   |
| tab                                | karta                                           | The keyboard key stays `Tab`. Never `zakładka`.                      |
| pane / split                       | panel / podziel                                 |                                                                      |
| sidebar / status bar / titlebar    | panel boczny / pasek stanu / pasek tytułu       | Never `pasek boczny`.                                                |
| command palette                    | paleta poleceń                                  |                                                                      |
| quick commands                     | szybkie polecenia                               |                                                                      |
| settings / preferences             | ustawienia / preferencje                        |                                                                      |
| shortcut / keybinding              | skrót klawiszowy                                |                                                                      |
| file explorer                      | eksplorator plików                              |                                                                      |
| host / server / SSH host           | host / serwer / host SSH                        |                                                                      |
| runtime                            | środowisko uruchomieniowe                       |                                                                      |
| automation / task                  | automatyzacja / zadanie                         |                                                                      |
| dashboard                          | pulpit                                          |                                                                      |
| sleep / wake (workspace)           | uśpij / wybudź                                  |                                                                      |
| pin / unpin / archive              | przypnij / odepnij / archiwizuj                 |                                                                      |
| setup script                       | skrypt konfiguracji                             |                                                                      |
| sparse checkout preset             | preset sparse checkout                          |                                                                      |
| sign in / sign out                 | zaloguj się / wyloguj się                       | Noun: `logowanie`.                                                   |
| account / provider / model         | konto / dostawca / model                        |                                                                      |
| effort (reasoning)                 | poziom rozumowania                              |                                                                      |
| token / usage / rate limit         | token / użycie / limit zapytań                  |                                                                      |
| credits / balance                  | kredyty / saldo                                 |                                                                      |
| notification                       | powiadomienie                                   |                                                                      |
| delete / remove                    | usuń                                            | Use context to keep `trwale usuń` distinct where English does.       |
| enable / disable / toggle          | włącz / wyłącz / pokaż/ukryj (panels)           |                                                                      |
| reload / retry                     | odśwież / spróbuj ponownie                      |                                                                      |
| loading…                           | Wczytywanie…                                    | Never `Ładowanie`.                                                   |
| release notes                      | informacje o wydaniu                            |                                                                      |
| pairing / pair device              | parowanie / sparuj urządzenie                   |                                                                      |
| VM / recipe                        | maszyna wirtualna (VM) / przepis                |                                                                      |
| clipboard / dictation              | schowek / dyktowanie                            |                                                                      |
| default / advanced / experimental  | domyślny / zaawansowane / eksperymentalne       |                                                                      |

Do not translate placeholders (`{{value0}}`), markup, commands, paths, keyboard keys, product names (Orca, Orca Mobile, Claude Code, Codex, GitHub, GitLab, Linear, SSH, WSL), or labels that belong to another product's UI.
