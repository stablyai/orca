# Plugin listing policy

These rules apply to every plugin listed in Orca's official and community catalogs and on the
[plugin directory](https://onorca.dev/plugins). For how to write and publish a plugin, see
[Writing an Orca plugin](plugin-authoring.md).

## Free to install and use

Orca doesn't support paid plugins yet. A listed plugin must be free to install and use:

- No paywalls, license keys, trials, or features locked behind a purchase or subscription.
- A plugin may connect to a paid service the user already has, such as their own API account.

## Publisher is the repository owner

`publisher` must be the GitHub or GitLab user or organization that owns the plugin's repository, the same
way Go module paths name their owner: `acme` for `github.com/acme/gleam-syntax`. See
[Publisher names and trust](plugin-catalog.md#publisher-names-and-trust).

## No impersonation

Don't use another person's, company's or product's name, logo or brand in a way that suggests
they made or endorse your plugin.

## Safe code

- No malware, and nothing that harms the user's machine, files or accounts.
- No obfuscated or minified-to-hide code. Bundled output is fine if the source is in the
  repository.
- No tracking, analytics or data collection about the user.

## No explicit content

Names, descriptions, icons, covers and screenshots must not contain sexual, violent or otherwise
explicit content.

## Reports and removal

Anyone can use **Report this plugin** on a plugin's directory page. A plugin that is reported and
breaks these rules is removed from the listings. If it is harmful, Orca's kill list also disables
copies that are already installed.
