# Pinned vendor sources

`manifest.json` records npm package versions, registry tarball integrity and SHA256 for the checked-in source/license files. No runtime CDN or package installation is required.

| Directory   | Package            | Version         | Purpose                                      |
| ----------- | ------------------ | --------------- | -------------------------------------------- |
| tweetnacl   | tweetnacl          | 1.0.3           | X25519/secretbox runtime                     |
| fflate      | fflate             | 0.8.3           | Bounded compressed frames and bundle windows |

`prepare-vendor.mjs` generates the ArkTS TweetNaCl module by replacing the Node crypto fallback and retargeting the UMD export to a local CommonJS object. HarmonyOS installs secure randomness through `NaclBinding`. The fflate UMD is copied unchanged from the pinned source.

Keep each dependency's LICENSE. Full attribution is packaged in `entry/src/main/resources/rawfile/licenses/THIRD_PARTY_NOTICES.txt` and verified by the preparation check.
