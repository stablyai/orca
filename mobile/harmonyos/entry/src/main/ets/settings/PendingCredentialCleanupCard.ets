import { common } from '@kit.AbilityKit';
import { HostCredentialCleanupState, loadPendingHostCredentialCleanup, retryPendingHostCredentialCleanup,
  subscribePendingHostCredentialCleanup } from '../storage/HostStore';
import { lucideColorFilter } from './LucideColor';
import { uiText } from './NativeUi';

const LABEL = 'settings.pendingCredentialCleanupCard.';

@Component
export struct PendingCredentialCleanupCard {
  @StorageProp('uiLocale') uiLocale: string = 'en';
  @StorageProp('themeScheme') scheme: string = 'dark';
  @StorageProp('themeBg') themeBg: string = '#0a0a0a';
  @StorageProp('themeRaised') themeRaised: string = '#262626';
  @StorageProp('themeText') themeText: string = '#fafafa';
  @StorageProp('themeSecondary') themeSecondary: string = '#acacac';
  @StorageProp('themeWarning') themeWarning: string = '#eab308';
  @State cleanup: HostCredentialCleanupState = { count: 0, storageUnreadable: false };
  @State retrying: boolean = false;
  @State retryFailed: boolean = false;
  private generation: number = 0;
  private unsubscribe: (() => void) | null = null;

  aboutToAppear(): void {
    this.unsubscribe = subscribePendingHostCredentialCleanup((): void => { this.refresh().catch(() => {}); });
    this.refresh().catch(() => {});
  }

  aboutToDisappear(): void {
    this.generation++;
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  private async refresh(): Promise<void> {
    if (this.retrying) { return; }
    let generation = ++this.generation;
    let result: HostCredentialCleanupState;
    try {
      let context = this.getUIContext().getHostContext() as common.Context;
      result = await loadPendingHostCredentialCleanup(context);
    } catch (e) { result = { count: this.cleanup.count, storageUnreadable: true }; }
    if (generation !== this.generation) { return; }
    this.cleanup = result;
    if (result.count === 0 && !result.storageUnreadable) { this.retryFailed = false; }
  }

  private async retry(): Promise<void> {
    if (this.retrying) { return; }
    let generation = ++this.generation;
    this.retrying = true;
    this.retryFailed = false;
    try {
      let context = this.getUIContext().getHostContext() as common.Context;
      let result = await retryPendingHostCredentialCleanup(context);
      if (generation !== this.generation) { return; }
      this.cleanup = result;
      this.retryFailed = result.count > 0 || result.storageUnreadable;
    } catch (e) {
      if (generation === this.generation) { this.retryFailed = true; }
    } finally {
      if (generation === this.generation) {
        this.retrying = false;
        this.refresh().catch(() => {});
      }
    }
  }

  private status(): string {
    if (this.retryFailed) { return uiText(LABEL + 'retryFailed', this.uiLocale); }
    let count = this.cleanup.count;
    if (count === 0) { return uiText(LABEL + 'statusCheckFailed', this.uiLocale); }
    let key = count === 1 ? 'cleanupUnconfirmed_one' : 'cleanupUnconfirmed_other';
    return uiText(LABEL + key, this.uiLocale).replace('{{count}}', String(count));
  }

  build() {
    if (this.cleanup.count > 0 || this.cleanup.storageUnreadable) {
      Row({ space: 12 }) {
        Image($r('app.media.lucide_key_round')).supportSvg2(true).width(16).height(16)
          .colorFilter(lucideColorFilter(this.themeWarning)).accessibilityLevel('no')
        Column({ space: 4 }) {
          Text(uiText(LABEL + 'title', this.uiLocale)).fontFamily('Geist').fontSize(15)
            .fontWeight(FontWeight.Medium).fontColor(this.themeText)
          Text(this.status()).fontFamily('Geist').fontSize(13).lineHeight(17).fontColor(this.themeSecondary)
        }.layoutWeight(1).alignItems(HorizontalAlign.Start)
        Button({ type: ButtonType.Normal }) {
          if (this.retrying) {
            LoadingProgress().width(16).height(16).color(this.themeSecondary)
          } else {
            Text(uiText('重试', this.uiLocale)).fontFamily('Geist').fontSize(12)
              .fontWeight(600).fontColor(this.themeText).textAlign(TextAlign.Center)
          }
        }.width(72).height(32).padding({ left: 4, right: 4 }).borderRadius(12).backgroundColor(this.themeRaised)
          .enabled(!this.retrying).accessibilityText(uiText(LABEL + 'retryCleanup', this.uiLocale))
          .onClick((): void => { this.retry().catch(() => {}); })
      }.width('100%').padding({ left: 16, right: 16, top: 12, bottom: 12 })
        .borderRadius(16).backgroundColor(this.scheme === 'light' ? this.themeBg : this.themeRaised).clip(true)
    }
  }
}
