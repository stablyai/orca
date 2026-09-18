{
  description = "Orca — next-gen IDE for parallel agentic development";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs =
    { self, nixpkgs }:
    let
      version = "1.4.200";

      # Prebuilt AppImages published with every Orca release. Bump `version` and
      # both hashes together (`nix-prefetch-url --type sha256 <url>` to refresh).
      sources = {
        x86_64-linux = {
          url = "https://github.com/stablyai/orca/releases/download/v${version}/orca-linux.AppImage";
          hash = "sha256-yC2d31MkMeDaUexdGJmg4xWqu453/ORezOf61HM/yWo=";
        };
        aarch64-linux = {
          url = "https://github.com/stablyai/orca/releases/download/v${version}/orca-linux-arm64.AppImage";
          hash = "sha256-PrD/mxEbg4Trm4/pjYCa7zVG9pVIF3WciCh3tHFgQUQ=";
        };
      };

      systems = builtins.attrNames sources;
      forAllSystems = nixpkgs.lib.genAttrs systems;

      orcaFor =
        system:
        let
          pkgs = nixpkgs.legacyPackages.${system};
          inherit (pkgs) lib appimageTools fetchurl;

          # Why: Ubuntu's `orca` is the GNOME screen reader, so Orca ships its
          # Linux binary and desktop entry as `orca-ide` to avoid the clash.
          pname = "orca-ide";
          src = fetchurl sources.${system};
          appimageContents = appimageTools.extractType2 { inherit pname version src; };
        in
        appimageTools.wrapType2 {
          inherit pname version src;

          # Ship the .desktop entry and full icon set the AppImage carries, and
          # point Exec at the wrapped binary instead of the bundled AppRun.
          extraInstallCommands = ''
            install -Dm444 ${appimageContents}/${pname}.desktop -t $out/share/applications
            substituteInPlace $out/share/applications/${pname}.desktop \
              --replace-fail 'Exec=AppRun' 'Exec=${pname}'
            for size in 16 24 32 48 64 128 256 512; do
              install -Dm444 \
                "${appimageContents}/usr/share/icons/hicolor/''${size}x''${size}/apps/${pname}.png" \
                "$out/share/icons/hicolor/''${size}x''${size}/apps/${pname}.png"
            done
          '';

          meta = {
            description = "Next-gen IDE for parallel agentic development";
            homepage = "https://github.com/stablyai/orca";
            downloadPage = "https://github.com/stablyai/orca/releases";
            changelog = "https://github.com/stablyai/orca/releases/tag/v${version}";
            license = lib.licenses.mit;
            sourceProvenance = [ lib.sourceTypes.binaryNativeCode ];
            platforms = systems;
            mainProgram = pname;
          };
        };
    in
    {
      packages = forAllSystems (
        system:
        let
          orca = orcaFor system;
        in
        {
          default = orca;
          orca = orca;
        }
      );

      apps = forAllSystems (system: rec {
        default = orca;
        orca = {
          type = "app";
          program = nixpkgs.lib.getExe self.packages.${system}.orca;
        };
      });
    };
}
