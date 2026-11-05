# Phorca plugins

Standalone plugins for Phorca live here. Each module has its own manifest, source, build and test commands, and license notices. Checking out this folder does not install a plugin into Phorca.

| Plugin | Purpose |
| --- | --- |
| [PR Guide](pr-guide/README.md) | Review a GitHub PR in a chaptered guide, then send inline comments to GitHub or a local agent session. |

To install PR Guide on a new machine, follow its [install instructions](pr-guide/README.md#install). The plugin lives below the repository root, so Phorca's **Git URL** installer cannot install this repository directly. The documented sparse checkout downloads the plugin folder, then **Local folder** installs its ready-to-use bundle.
