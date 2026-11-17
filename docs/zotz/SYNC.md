# Sincronizar Zotz con upstream (Orca)

Zotz sigue a [stablyai/orca](https://github.com/stablyai/orca). El diff contra upstream se mantiene chico a propósito (ver reglas en [`PLAN.md`](./PLAN.md)) para que esto sea barato.

## Una vez por clon

```sh
git remote add upstream https://github.com/stablyai/orca.git
git remote -v   # origin = HugoRodriguezDEV/zotz, upstream = stablyai/orca
```

## Cada sync

```sh
git fetch upstream
git switch main && git pull --ff-only origin main
git switch -c zotz/sync-$(date +%F)       # zotz/sync-YYYY-MM-DD
git rebase upstream/main                    # o: git merge upstream/main
```

- **Rebase** deja la historia lineal (commits de Zotz encima de Orca), pero reescribe `main` del fork: el PR del sync se integra con _rebase and merge_ y luego cada clon hace `git reset --hard origin/main`.
- **Merge** es más simple cuando hay muchos commits de Zotz o el rebase da demasiados conflictos. Usa uno u otro; no mezcles en el mismo sync.

### Resolver conflictos

Los conflictos esperables están en lo que Zotz toca a propósito:

| Zona                              | Qué conservar                                                                                                                                       |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `.github/workflows/*`             | Los guards `github.repository == 'stablyai/orca'` en jobs que publican. Si upstream agrega un workflow nuevo de release/publish, agrégale el guard. |
| `LICENSE`                         | Las dos líneas de copyright (la de upstream intacta + la de Zotz).                                                                                  |
| `README.md`                       | La nota "Zotz es un fork de Orca" arriba; el resto, lo de upstream.                                                                                 |
| Archivos `zotz-*` y `docs/zotz/`  | Son solo de Zotz; upstream no los toca.                                                                                                             |
| Defaults / guards de fases 1–3    | El cambio de Zotz (default, guard, string visible) sobre el código nuevo de upstream.                                                               |
| Actualizador (`src/main/updater`) | URLs desde `ZOTZ_RELEASE_REPO`, nunca `stablyai/orca`. `node config/scripts/release/zotz-check-release-repo-refs.mjs` lo revisa (también en CI).    |

Después de resolver:

```sh
git rebase --continue          # o git commit si fue merge
pnpm install
pnpm tc
pnpm check:changed             # gate obligatorio antes de push; nunca --no-verify
git push -u origin zotz/sync-$(date +%F)    # tras rebase de una rama ya publicada: --force-with-lease
gh pr create --base main
```

### Revisar workflows nuevos

Tras cada sync, busca workflows de publish que no estén guardados:

```sh
grep -lE "secrets\.([A-FH-Z]|G[A-HJ-Z])[A-Z_]*|secrets: inherit" .github/workflows/*.y*ml | xargs grep -L "stablyai/orca"
```

Hoy solo sale `release-javascript.yml` (bundle con la llave de PostHog; no publica). Cualquier otro que salga y publique releases, casks, docs o builds firmados necesita el guard en su job de entrada.
