package dev.orca.automationproof;

import android.app.Activity;
import android.content.Intent;
import android.os.Bundle;

public final class Launcher extends Activity {
    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        Intent route = new Intent(this, RouteActivity.class);
        route.putExtra("mode", getIntent().getStringExtra("mode"));
        route.putExtra("shellPid", android.os.Process.myPid());
        startActivity(route);
        finish();
    }
}
