const release = require('./electron-builder.config.cjs')

// CI discards these packages after smoke tests; keep release compression unchanged.
module.exports = {
  ...release,
  deb: { ...release.deb, fpm: [...(release.deb.fpm ?? []), '--deb-compression-level=1'] },
  rpm: { ...release.rpm, fpm: [...(release.rpm.fpm ?? []), '--rpm-compression-level=1'] }
}
