# German (de) UI Glossary and Style

Catalog: `src/renderer/src/i18n/locales/de.json`. Missing keys fall back to English at runtime. System detection maps `de`, `de-DE`, `de-AT`, `de-CH` and POSIX tags such as `de_DE.UTF-8` to `de`.

## Voice

- Avoid addressing the user. Prefer neutral phrasing: `Branch auswählen`, `Keine Worktrees gefunden`, `Datei konnte nicht gespeichert werden.`
- When a sentence must address the user, use informal `du` consistently (`dein`, `dir`), lowercase. Never use `Sie`.
- Buttons, menu items and commands use the infinitive: `Öffnen`, `Speichern`, `Löschen`, `Entfernen`, `Erneut versuchen`, `Abbrechen`.
- Failures: `… konnte nicht geladen werden.` in sentences, `Laden fehlgeschlagen` in short labels.
- Confirmations are impersonal questions: `Fenster schließen?`, `Worktree löschen?`
- German has no title case. Capitalize nouns and the first word only, even when the English label uses title case. Keep brand names and acronyms as written.
- Labels have no final period. Use `…`, not `...`. Use German quotes `„…“` in prose; keep backticks and code quoting as in the source.
- Join English terms to German words with a hyphen: `Worktree-Name`, `Branch-Name`, `SSH-Verbindung`, `PR-Titel`, `Git-Repository`.
- German strings run about 30% longer than English. Prefer the shorter natural wording for buttons, tabs and badges, but never drop meaning.
- Plurals follow English (`_one` / `_other`). Keep `{{count}}` wherever the English form has it.

## Terms

Keep Git and developer terms that German developers use in English. Use the noun genders below for articles and adjective endings.

| English                      | German                                        | Note                                                       |
| ---------------------------- | --------------------------------------------- | ---------------------------------------------------------- |
| worktree                     | der Worktree, die Worktrees                   | Distinct from workspace.                                   |
| workspace                    | der Arbeitsbereich                            |                                                            |
| repository / repo            | das Repository (die Repositorys) / das Repo   |                                                            |
| branch / base branch         | der Branch (die Branches) / Basis-Branch      |                                                            |
| commit                       | der Commit; verb `committen`                  |                                                            |
| pull request / PR            | der Pull Request / PR                         | `merge request` stays `Merge Request` (GitLab).            |
| merge, rebase, diff, stash   | Merge, Rebase, Diff, Stash                    | Verbs: `mergen`, `rebasen`, `stashen`.                     |
| checkout                     | Checkout; verb `auschecken`                   |                                                            |
| push / pull / fetch          | Push / Pull / Fetch                           | Verbs: `pushen`, `pullen`, `fetchen`.                      |
| remote (Git) / remote host   | das Remote / Remote-Host                      | `remote` as an adjective: `entfernt`.                      |
| issue                        | das Issue                                     |                                                            |
| review / code review         | das Review / Code-Review                      |                                                            |
| check (CI)                   | der Check                                     |                                                            |
| label (issue/PR)             | das Label, die Labels                         |                                                            |
| approve / comment            | genehmigen / der Kommentar                    |                                                            |
| source control               | Quellcodeverwaltung                           |                                                            |
| agent                        | der Agent, die Agenten                        |                                                            |
| chat / prompt                | der Chat / der Prompt                         |                                                            |
| skill / plugin / hook        | der Skill / das Plugin / der Hook             |                                                            |
| session                      | die Sitzung                                   |                                                            |
| terminal / shell             | das Terminal / die Shell                      |                                                            |
| tab                          | der Tab                                       | The keyboard key stays `Tab`.                              |
| pane / panel                 | der Bereich / das Panel                       | Split pane: `Bereich teilen`. Keep the two terms distinct. |
| sidebar / status bar         | die Seitenleiste / die Statusleiste           |                                                            |
| editor / browser             | der Editor / der Browser                      |                                                            |
| command palette / quick open | Befehlspalette / Schnellöffnen                |                                                            |
| file / folder / directory    | Datei / Ordner / Verzeichnis                  |                                                            |
| project                      | das Projekt                                   |                                                            |
| host / server / SSH host     | der Host / der Server / der SSH-Host          |                                                            |
| automation / task            | die Automatisierung / die Aufgabe             |                                                            |
| dashboard                    | das Dashboard                                 |                                                            |
| settings                     | die Einstellungen                             |                                                            |
| shortcut / keybinding        | das Tastenkürzel / die Tastenbelegung         |                                                            |
| sign in / sign out           | anmelden / abmelden                           |                                                            |
| account / provider / model   | das Konto / der Anbieter / das Modell         |                                                            |
| token (LLM or auth)          | der Token                                     |                                                            |
| usage / quota / rate limit   | die Nutzung / das Kontingent / das Ratenlimit |                                                            |
| credits / balance            | Credits / das Guthaben                        |                                                            |
| notification                 | die Benachrichtigung                          |                                                            |
| delete / remove              | löschen / entfernen                           | Keep the two terms distinct.                               |
| enable / disable / default   | aktivieren / deaktivieren / Standard          |                                                            |
| pin / unread / archive       | anheften / ungelesen / archivieren            |                                                            |
| environment / sandbox        | die Umgebung / die Sandbox                    |                                                            |
| dictation                    | das Diktat; verb `diktieren`                  |                                                            |
| clipboard                    | die Zwischenablage                            |                                                            |
| port forwarding              | die Portweiterleitung                         |                                                            |

Do not translate placeholders (`{{value0}}`), markup, commands, paths, keyboard keys, or labels that belong to another product's UI.
