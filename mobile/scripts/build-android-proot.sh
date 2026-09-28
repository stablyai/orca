#!/usr/bin/env bash
# Builds proot + its loader for arm64 Android into the orca-local-runtime module assets.
# Why not a prebuilt: every published Android proot is 4 KiB-aligned and segfaults on 16 KiB-page
# devices (Android 15+ and every Pixel image since), and Play requires 16 KiB alignment anyway.
set -euo pipefail

NDK="${ANDROID_NDK_HOME:-${ANDROID_HOME:-$HOME/Library/Android/sdk}/ndk/29.0.14206865}"
API=26
PROOT_REF="v0.15_release" # green-green-avk/proot: the Android fork with link2symlink + unbundled loader
TALLOC_V="2.4.2"

case "$(uname -s)" in
  Darwin) HOST_TAG=darwin-x86_64 ;; # NDK ships a universal binary under this name
  Linux) HOST_TAG=linux-x86_64 ;;
  *) echo "unsupported build host: $(uname -s)" >&2; exit 1 ;;
esac
TOOLCHAIN="$NDK/toolchains/llvm/prebuilt/$HOST_TAG"
[ -d "$TOOLCHAIN" ] || { echo "NDK toolchain not found: $TOOLCHAIN" >&2; exit 1; }

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/modules/orca-local-runtime/android/src/main/assets/orca-local-runtime"
WORK="${TMPDIR:-/tmp}/orca-proot-build"
rm -rf "$WORK" && mkdir -p "$WORK/static/lib" "$WORK/static/include" "$WORK/bin"

export CC="$TOOLCHAIN/bin/aarch64-linux-android$API-clang"
export AR="$TOOLCHAIN/bin/llvm-ar" RANLIB="$TOOLCHAIN/bin/llvm-ranlib" STRIP="$TOOLCHAIN/bin/llvm-strip"
PAGE_FLAGS="-Wl,-z,max-page-size=16384 -Wl,-z,common-page-size=16384"

# talloc's waf build shells out to `python`; newer hosts only ship python3.
ln -sf "$(command -v python3)" "$WORK/bin/python"
export PATH="$WORK/bin:$PATH"

cd "$WORK"
curl -fsSL "https://download.samba.org/pub/talloc/talloc-$TALLOC_V.tar.gz" | tar xz
curl -fsSL "https://github.com/green-green-avk/proot/archive/$PROOT_REF.tar.gz" | tar xz

(
  cd "talloc-$TALLOC_V"
  cat >cross-answers.txt <<EOF
Checking uname sysname type: "Linux"
Checking uname machine type: "dontcare"
Checking uname release type: "dontcare"
Checking uname version type: "dontcare"
Checking simple C program: OK
rpath library support: OK
-Wl,--version-script support: FAIL
Checking getconf LFS_CFLAGS: OK
Checking for large file support without additional flags: OK
Checking for -D_FILE_OFFSET_BITS=64: OK
Checking for -D_LARGE_FILES: OK
Checking correct behavior of strtoll: OK
Checking for working strptime: OK
Checking for C99 vsnprintf: OK
Checking for HAVE_SHARED_MMAP: OK
Checking for HAVE_MREMAP: OK
Checking for HAVE_INCOHERENT_MMAP: OK
Checking for HAVE_SECURE_MKSTEMP: OK
Checking getconf large file support flags work: OK
Checking for HAVE_IFACE_IFCONF: FAIL
EOF
  ./configure build --disable-rpath --disable-python --cross-compile --cross-answers=cross-answers.txt
  "$AR" rcs "$WORK/static/lib/libtalloc.a" bin/default/talloc*.o
  cp talloc.h "$WORK/static/include/"
)

(
  cd "proot-${PROOT_REF#v}/src"
  # lld places `-Ttext` code at that file offset (a 128 GiB sparse loader); --image-base is the lld spelling.
  sed -i.bak 's|-Ttext=$(LOADER_ADDRESS$1),-z,noexecstack|--image-base=$(LOADER_ADDRESS$1),-z,noexecstack,-z,max-page-size=16384|' GNUmakefile
  # link2symlink turns a socket link into symlinks whose stat reports inode 0, which breaks orcad's
  # daemon endpoint publish (it verifies dev+ino). EPERM sends that code down its rename path instead.
  perl -0pi -e 's|(if \(S_ISDIR\(statl\.st_mode\)\)\n\t\treturn -EPERM;)|$1\n\tif (S_ISSOCK(statl.st_mode))\n\t\treturn -EPERM;|' extension/link2symlink/link2symlink.c
  grep -q 'S_ISSOCK(statl.st_mode)' extension/link2symlink/link2symlink.c || { echo "link2symlink socket patch did not apply" >&2; exit 1; }
  export CFLAGS="-I$WORK/static/include -Werror=implicit-function-declaration"
  export LDFLAGS="-L$WORK/static/lib $PAGE_FLAGS"
  export PROOT_UNBUNDLE_LOADER='../libexec/proot'
  make proot loader/loader
  mkdir -p "$OUT"
  "$STRIP" -o "$OUT/proot" proot
  "$STRIP" -o "$OUT/loader" loader/loader
)

READELF="$TOOLCHAIN/bin/llvm-readelf"
for f in "$OUT/proot" "$OUT/loader"; do
  if "$READELF" -lW "$f" | awk '/LOAD/ && $NF != "0x4000" { bad = 1 } END { exit !bad }'; then
    echo "$f is not 16 KiB aligned" >&2
    exit 1
  fi
done
echo "proot assets written to $OUT"
