# PR 25658 final-head rendered QA

Tested head: `ef21e3fc62ec75aa8a605fddb3ac9ee9f3ebc4f8`; base: `abfc971b6e7f5e1761921b23ce9bee768ef8dfab`.

## Isolation and build

- `pnpm exec electron-vite build` completed before launch.
- Hidden CDP-only app identity: `Orca: ef21e3fc62`; label `pr25658-review-qa @ ef21e3fc62`; repo root `/Users/m4air/orca/workspaces/orca/pr25658-review-qa`; renderer `127.0.0.1:5176`; CDP `127.0.0.1:9603`.
- The app used a fresh isolated HOME, user-data directory, CODEX_HOME, and CLAUDE_CONFIG_DIR under `~/orca-qa/pr-25658/remote/rig/final`, with `ORCA_BACKGROUND_LAUNCH=1`; no live account, agent chat, OS input, or activation was used.
- The recorded f17 app runner and verified descendants were stopped first: `81722,82042,82189,82508,82314,82313,82309,82308,82043`.
- Real Codex-only digest timeline (contents never read): earlier f17 pre/post `hooks=78922a784ee78e9e50587e93628cd3b9d4dfbe49087adc4514e6781cea38cbb9`, `config=94bb95217e86b0ed8cf4cd15da0c0c30762dcd4c0668070110bce9f6223d57da`; final-run pre/post `hooks=78922a784ee78e9e50587e93628cd3b9d4dfbe49087adc4514e6781cea38cbb9`, `config=4702fc9a505e48b289659f4138fe300ef8958dd578ac72a2b776a2044c68db19`. The config digest changed before this final launch and remained stable throughout it; no cause is asserted.

## Final-head rendered evidence

- Default dark and light both rendered the seeded, inert Preview above the controls. It shows no personal chat/path and no theme caption; closing line is fully visible at 14/12.
- Match terminal interface toggled visibly on and off. Contrast pointer drag changed preview mix `78% → 78.44%` while saved contrast stayed 100, then mouse release committed 101; keyboard left/right left the slider thumb focused.
- Comfortable/Wide/Full set visible caps `46rem`/`60rem`/`none`; the settings panel itself constrained each to a 706px rendered column within a 738px preview, so it cannot demonstrate the wider limits.
- At text 20/code 18, the fixed 440px preview clips the closing sample. Narrow 980px viewport: preview 542px, column 510px, closing top/bottom 451/480 (40px below bottom); wide 1600px: preview 738px, column 706px, closing 451/480 (40px below bottom). Code stayed visible (bottom 438px).
- Every final-head locale was rendered at 20/18. en/es/fr/ja/ko close at 451/480 and clip; zh closes at 423/451 and clips by 11px. The localized Preview headers and seeded sample content rendered in all six.

## Artifacts

- Geometry: `/Users/m4air/orca-qa/pr-25658/remote/final-geometry.json`
- Driver: `/Users/m4air/orca-qa/pr-25658/remote/final-driver.mjs`
- Launcher: `/Users/m4air/orca-qa/pr-25658/remote/launch-final.sh`
- Screens: `/Users/m4air/orca-qa/pr-25658/remote/shots/final-dark-default.png`, `final-light-default.png`, `final-match-on.png`, `final-narrow-20-18.png`, `final-wide-20-18.png`, and `final-locale-ja-20-18.png`.

The f17 report and images are retained only as supplemental evidence; this report, geometry, screenshots, and app identity are exact-final-head proof. The outstanding issue is the confirmed max-size closing-line clipping; no source fix, PR comment, or PR-body edit was made.
