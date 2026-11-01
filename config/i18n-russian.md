# Russian localization

Russian uses the built-in locale `ru`. System detection recognizes regional and POSIX tags such as `ru-RU`, `ru-KZ` and `ru_RU.UTF-8`. Renderer catalogs and native menu translations load lazily. The selected language also supplies the locale for the existing number, date, relative-time and weekday formatters. Paired web clients keep their language preference locally when a server is older or offline.

The nested i18next catalog lives at `src/renderer/src/i18n/locales/ru.json`. Missing translations use the current English fallback. Standalone React Native mobile screens have separate copy; the shared desktop renderer used by paired web clients uses this catalog. Provider transcripts, approval options, user content and third-party plugin content retain their original language.

## Translation workflow

Keep inline English defaults and `en.json` synchronized with the current source. Run `pnpm run sync:localization-catalog` to add missing literal defaults and `pnpm run sync:localization-runtime-catalog` to regenerate the English boot subset. Apply reviewed translations with `node config/scripts/apply-translation-delta.mjs <delta.json>`, which rejects empty values and changed placeholders.

Translate complete phrases in context. Preserve product names, command syntax, paths and interpolation variables. Reuse a translation only after checking both the English source and its UI meaning. Native language labels, technical identifiers and interpolation-only values may intentionally match English. Never exempt ordinary untranslated prose.

## Glossary

Use these renderings unless context clearly requires otherwise. Address the user as «вы» (lowercase mid-sentence). Buttons and commands use the infinitive («Создать», «Открыть»); instructions use the polite imperative («Выберите»). Use sentence case, «ёлочки» quotes, a single `…` character, and write «ё» consistently. Keep product names (Orca, Claude Code, Codex, GitHub, GitLab), commands, paths and placeholders in their original form.

| English         | Russian                | Notes                                                                        |
| --------------- | ---------------------- | ---------------------------------------------------------------------------- |
| workspace       | рабочее пространство   | Сущность Orca, объединяющая рабочие инструменты                              |
| worktree        | рабочее дерево         | Git worktree; отличать от workspace. Мн. ч. «рабочие деревья»                |
| agent           | агент                  | В действиях — «запустить агента», «остановить агента»                        |
| repository      | репозиторий            | Также для сокращения repo                                                    |
| branch          | ветка                  | Base branch — «базовая ветка», target branch — «целевая ветка»               |
| commit          | коммит                 | Кнопка — «Закоммитить»; в пояснениях — «создать коммит»                      |
| pull request    | пул-реквест            | Склоняется: «пул-реквеста»                                                   |
| merge request   | запрос на слияние      | Соответствует терминологии GitLab                                            |
| issue           | задача                 | Для сущности трекера GitHub, GitLab, Linear или Jira                         |
| terminal        | терминал               | «открыть терминал», «вкладка терминала»                                      |
| tab             | вкладка                | Название клавиши Tab сохранять латиницей                                     |
| pane            | панель                 | Самостоятельная область внутри раскладки                                     |
| split           | разделение             | Существительное — «разделение»                                               |
| sidebar         | боковая панель         | При необходимости «левая боковая панель» или «правая боковая панель»         |
| settings        | настройки              | Название раздела — «Настройки», отдельный параметр — «настройка»             |
| host            | сервер                 | SSH host — «SSH-сервер»                                                      |
| remote          | удалённый              | Прилагательное согласовывать с существительным                               |
| session         | сессия                 | «сессия агента», «сессия терминала»                                          |
| plugin          | плагин                 | «установить плагин», мн. ч. «плагины»                                        |
| skill           | навык                  | «навык агента», «установить навык»                                           |
| automation      | автоматизация          | Исчисляемая сущность: «создать автоматизацию», «запуски автоматизации»       |
| review          | проверка               | Code review — «проверка кода»                                                |
| diff            | сравнение              | Результат сравнения — «различия», показываемые правки — «изменения»          |
| merge           | слияние                | Кнопка — «Слить», процесс — «слияние», состояние — «Выполняется слияние»     |
| rebase          | перебазирование        | Кнопка — «Перебазировать», abort rebase — «Прервать перебазирование»         |
| stash           | stash                  | Не склонять: «убрать изменения в stash»                                      |
| checkout        | переключиться на ветку | Для действия с веткой, включая check out                                     |
| push            | отправить              | Отправка коммитов в удалённый репозиторий                                    |
| pull            | получить и слить       | При rebase — «Получить и перебазировать»                                     |
| fetch           | получить изменения     | Получает данные из удалённого репозитория без слияния с текущей веткой       |
| project         | проект                 | Название сущности Orca и проекта во внешнем трекере                          |
| folder          | папка                  | Основной термин для файлового интерфейса и выбора расположения               |
| file            | файл                   | Filename — «имя файла», file path — «путь к файлу»                           |
| quota           | квота                  | «квота исчерпана», «остаток квоты»                                           |
| usage           | использование          | Для количества израсходованных токенов естественно «расход токенов»          |
| dictation       | диктовка               | «режим диктовки», «начать диктовку», «остановить диктовку»                   |
| browser         | браузер                | Built-in browser — «встроенный браузер»                                      |
| notification    | уведомление            | Notification area — «область уведомлений»                                    |
| shortcut        | сочетание клавиш       | Ярлык приложения — отдельное значение                                        |
| command palette | палитра команд         | Устоявшееся название в русской терминологии VS Code                          |
| editor          | редактор               | При необходимости «редактор кода», «редактор CSV»                            |
| source control  | управление версиями    | Название раздела и Git-функций                                               |
| staged          | в индексе              | Staged changes — «изменения в индексе»                                       |
| unstaged        | не в индексе           | Unstage — «Убрать из индекса»                                                |
| conflict        | конфликт               | Merge conflict — «конфликт слияния», resolve conflict — «разрешить конфликт» |
| prompt          | запрос                 | Shell prompt — «приглашение командной строки»                                |
| model           | модель                 | Названия и идентификаторы моделей сохранять в официальном написании          |
| provider        | провайдер              | При необходимости уточнять: «провайдер моделей»                              |
| chat            | чат                    | «новый чат», «открыть чат», «название чата»                                  |
| thread          | обсуждение             | Цепочка сообщений или комментариев                                           |
| run             | запуск                 | Кнопка — «Запустить»; отдельная команда — «Выполнить»                        |
| task            | задача                 | Задание агенту или элемент списка задач                                      |
| ticket          | задача                 | Linked ticket — «связанная задача»                                           |
| account         | учётная запись         | «добавить учётную запись», «войти в учётную запись»                          |
| sign in         | войти                  | Существительное — «вход»                                                     |
| archive         | архивировать           | Процесс — «архивация», состояние — «В архиве»                                |
| pin             | закрепить              | Обратное действие — «Открепить»                                              |
| theme           | тема                   | «светлая тема», «тёмная тема»                                                |
| preview         | предпросмотр           | «открыть предпросмотр», «предпросмотр темы»                                  |
| permission      | разрешение             | Файловые permissions — «права доступа»                                       |
| approve         | одобрить               | В прямом запросе доступа — «Разрешить»                                       |
| comment         | комментарий            | Действие — «Добавить комментарий», inline comment — «комментарий к строке»   |
| environment     | окружение              | Runtime environment — «среда выполнения»; переменная окружения               |
| sandbox         | песочница              | В пояснении — «изолированная среда»                                          |
| port            | порт                   | «локальный порт», «удалённый порт», «перенаправление портов»                 |
| SSH             | SSH                    | Общепринятая аббревиатура протокола: латиницей, прописными, без склонения    |
| token           | токен                  | «1 токен», «2 токена», «5 токенов»                                           |
| Git             | Git                    | Без склонения: «репозиторий Git»                                             |
| PR              | PR                     | Прописные латинские буквы, без окончаний: «этот PR», «3 PR»                  |
| MR              | MR                     | Прописные латинские буквы, без окончаний: «этот MR», «3 MR»                  |

## Plurals and source grammar

Pass `count` for count-based messages. Russian uses `one`, `few`, `many` and `other`; test zero, singular, small plurals, teens, compound counts and fractions. The validator permits additional locale-specific forms only for an existing English `_other` family and valid CLDR categories, and checks their placeholders against that source.

Prefer a whole sentence over translated fragments or JavaScript singular/plural concatenation. Where changing legacy behavior is unnecessary, a reviewed count-neutral phrase can preserve grammar. Keep original provider content separate from application labels.

## Verification

Run these catalog checks after editing source copy or translations:

```sh
pnpm run verify:localization-catalogs
pnpm run verify:localization-extraction
pnpm run verify:localization-coverage
```

Completeness measures coverage of the current English catalog; it does not prove linguistic quality or rendered behavior.
