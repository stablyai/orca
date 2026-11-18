#!/usr/bin/env bash
# Creates, once, the self-signed certificate Zotz signs its macOS builds with (docs/zotz/UPDATES-SPEC.md §6).
# Its identity stays the same across builds, so Squirrel.Mac accepts updates. Nothing is uploaded.
set -euo pipefail

NAME="Zotz Release Signing"
OUT_DIR="${1:-$HOME/zotz-mac-signing}"
P12="$OUT_DIR/zotz-mac-signing.p12"

if [[ -e "$P12" ]]; then
  echo "$P12 already exists. A new certificate changes the app identity and forces one manual reinstall." >&2
  exit 1
fi

umask 077
mkdir -p "$OUT_DIR"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

cat > "$work/cert.cnf" <<EOF
[req]
distinguished_name = dn
x509_extensions = ext
prompt = no
[dn]
CN = $NAME
[ext]
basicConstraints = critical, CA:false
keyUsage = critical, digitalSignature
extendedKeyUsage = critical, codeSigning
subjectKeyIdentifier = hash
EOF

# macOS `security import` cannot read the PKCS#12 encryption OpenSSL 3 uses by default.
openssl_bin=openssl
[[ -x /usr/bin/openssl ]] && openssl_bin=/usr/bin/openssl
legacy=()
"$openssl_bin" version | grep -q '^OpenSSL 3' && legacy=(-legacy)

"$openssl_bin" req -x509 -newkey rsa:3072 -sha256 -nodes -days 3650 \
  -keyout "$work/key.pem" -out "$work/cert.pem" -config "$work/cert.cnf" 2>/dev/null
password="$("$openssl_bin" rand -base64 24)"
"$openssl_bin" pkcs12 -export ${legacy[@]+"${legacy[@]}"} -name "$NAME" \
  -inkey "$work/key.pem" -in "$work/cert.pem" -out "$P12" -passout "pass:$password"
printf '%s' "$password" > "$OUT_DIR/password.txt"
fingerprint="$("$openssl_bin" x509 -in "$work/cert.pem" -noout -fingerprint -sha1 | sed 's/.*=//')"

cat <<EOF
Created $P12 (SHA-1 $fingerprint) and its password in $OUT_DIR/password.txt.

1. Save both files in your password manager. Losing them means one manual reinstall on every Mac.
2. Store them as GitHub secrets (only what you pipe in is uploaded):
     base64 -i "$P12" | gh secret set ZOTZ_MAC_CERT_P12 -R HugoRodriguezDEV/zotz
     gh secret set ZOTZ_MAC_CERT_PASSWORD -R HugoRodriguezDEV/zotz < "$OUT_DIR/password.txt"
3. Delete $OUT_DIR from this Mac once both are saved.
EOF
